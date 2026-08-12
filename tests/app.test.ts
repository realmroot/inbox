import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../server/app'
import type { Authenticator } from '../server/auth'
import type { AgentDirectory } from '../server/agent-directory'
import { receiveEmail } from '../server/email'
import { API_VERSION } from '../shared/contracts'

const authenticate: Authenticator = async (request, runtimeEnv) => {
  const subject = request.headers.get('x-test-agent')
  if (!subject) throw new Error('x-test-agent is required in tests')
  return {
    owner: { issuer: runtimeEnv.OIDC_ISSUER, subject: `controller-${subject}` },
    agent: { issuer: runtimeEnv.OIDC_ISSUER, subject },
    scopes: [],
  }
}

const alphaSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc0'
const betaSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc1'
const emailSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc3'
const missingSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc4'
const knownAgents = new Set([alphaSubject, betaSubject, emailSubject])
const agentUsernames = new Map([
  [alphaSubject, 'alpha-agent'],
  [betaSubject, 'beta-agent'],
  [emailSubject, 'email-agent'],
])
const agentDirectory: AgentDirectory = {
  find: async (issuer, subject) => {
    const username = agentUsernames.get(subject)
    return knownAgents.has(subject) && username ? { issuer, subject, username } : null
  },
  findByUsername: async (issuer, username) => {
    const subject = [...agentUsernames].find(([, value]) => value === username)?.[0]
    return subject ? { issuer, subject, username } : null
  },
}
const app = createApp(authenticate, () => agentDirectory)
const headers = (agent: string, extra: HeadersInit = {}) => ({
  'API-Version': API_VERSION,
  'x-test-agent': agent,
  ...Object.fromEntries(new Headers(extra)),
})

describe('Agent Inbox API', () => {
  it('publishes Realmroot discovery and a resource-only Restish contract [spec: inbox/resource-discovery]', async () => {
    const root = await app.request('https://inbox.test/api', {}, env)
    expect(root.status).toBe(200)
    expect(root.headers.get('link')).toContain('rel="service-desc"')

    const metadata = await app.request('https://inbox.test/.well-known/oauth-protected-resource/api', {}, env)
    expect(await metadata.json()).toMatchObject({
      resource: 'https://inbox.test/api',
      scopes_supported: [
        'mailbox:read',
        'mailbox:manage',
        'messages:read',
        'messages:create',
        'messages:manage',
      ],
    })

    const response = await app.request('https://inbox.test/api/openapi.json', {}, env)
    const document = await response.json<Record<string, unknown>>()
    const paths = document.paths as Record<string, Record<string, { operationId?: string; 'x-cli-name'?: string; security?: Array<Record<string, string[]>> }>>
    expect(Object.keys(paths)).toEqual(['/mailbox', '/messages', '/messages/{messageId}', '/messages/{messageId}/attachments/{attachmentId}'])
    expect(paths['/messages']?.post?.operationId).toBe('createMessage')
    expect(paths['/messages']?.post?.['x-cli-name']).toBe('send')
    expect(paths['/messages']?.post?.security).toEqual([{ RealmrootOAuth: ['messages:create'] }])
    expect(Object.keys(paths).some((path) => /entries|inbox|outbox/.test(path))).toBe(false)
    expect(JSON.stringify(paths['/messages']?.post)).toContain('IdempotencyReplayed')
  })

  it('auto-provisions one stable mailbox and retires replaced aliases [spec: inbox/mailbox-alias]', async () => {
    const first = await app.request('https://inbox.test/api/mailbox', { headers: headers(alphaSubject) }, env)
    expect(first.status).toBe(200)
    const mailbox = await first.json<{ id: string; addresses: { stable: string; alias: string | null } }>()
    expect(mailbox.addresses.stable).toBe('alpha-agent@agents.test')

    const updated = await app.request('https://inbox.test/api/mailbox', {
      method: 'PATCH',
      headers: headers(alphaSubject, { 'Content-Type': 'application/merge-patch+json', 'If-Match': first.headers.get('etag')! }),
      body: JSON.stringify({ alias: 'release-agent' }),
    }, env)
    expect(updated.status).toBe(200)
    expect((await updated.json<{ addresses: { alias: string } }>()).addresses.alias).toBe('release-agent@agents.test')

    const removed = await app.request('https://inbox.test/api/mailbox', {
      method: 'PATCH',
      headers: headers(alphaSubject, { 'Content-Type': 'application/merge-patch+json', 'If-Match': updated.headers.get('etag')! }),
      body: JSON.stringify({ alias: null }),
    }, env)
    expect(removed.status).toBe(200)

    const other = await app.request('https://inbox.test/api/mailbox', { headers: headers(betaSubject) }, env)
    const unavailable = await app.request('https://inbox.test/api/mailbox', {
      method: 'PATCH',
      headers: headers(betaSubject, { 'Content-Type': 'application/merge-patch+json', 'If-Match': other.headers.get('etag')! }),
      body: JSON.stringify({ alias: 'release-agent' }),
    }, env)
    expect(unavailable.status).toBe(409)
  })

  it('sends, receives, filters, reads, and idempotently replays one message [spec: inbox/agent-message-loop]', async () => {
    expect(await env.DB.prepare('SELECT id FROM mailbox WHERE agent_subject = ?').bind(betaSubject).first()).toBeNull()
    const createRequest = {
      method: 'POST',
      headers: headers(alphaSubject, { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-message-0001' }),
      body: JSON.stringify({ recipients: [`agent:${betaSubject}`], subject: 'Hello', content: { text: 'Ping' } }),
    }
    const created = await app.request('https://inbox.test/api/messages', createRequest, env)
    expect(created.status).toBe(201)
    const sent = await created.json<{ id: string; direction: string; recipients: Array<{ deliveryStatus: string }> }>()
    expect(sent).toMatchObject({ direction: 'outbound' })
    expect(sent.recipients[0]?.deliveryStatus).toBe('delivered')
    expect(await env.DB.prepare('SELECT id FROM mailbox WHERE agent_subject = ?').bind(betaSubject).first()).not.toBeNull()

    const replay = await app.request('https://inbox.test/api/messages', createRequest, env)
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect((await replay.json<{ id: string }>()).id).toBe(sent.id)

    const inbox = await app.request('https://inbox.test/api/messages?direction=inbound', { headers: headers(betaSubject) }, env)
    expect(inbox.status).toBe(200)
    const received = await inbox.json<{ items: Array<{ id: string; direction: string; state: string }> }>()
    expect(received.items).toEqual([expect.objectContaining({ id: sent.id, direction: 'inbound', state: 'unread' })])

    const shown = await app.request(`https://inbox.test/api/messages/${sent.id}`, { headers: headers(betaSubject) }, env)
    expect(shown.headers.get('etag')).toBe('"message-1"')
    expect(shown.headers.get('cache-control')).toBe('private, no-store, no-transform')
    const read = await app.request(`https://inbox.test/api/messages/${sent.id}`, {
      method: 'PATCH',
      headers: headers(betaSubject, { 'Content-Type': 'application/merge-patch+json', 'If-Match': shown.headers.get('etag')! }),
      body: JSON.stringify({ state: 'read' }),
    }, env)
    expect(read.status).toBe(200)
    expect((await read.json<{ state: string }>()).state).toBe('read')
    expect(read.headers.get('etag')).toBe('"message-2"')

    const reply = await app.request('https://inbox.test/api/messages', {
      method: 'POST',
      headers: headers(betaSubject, { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-message-reply-0001' }),
      body: JSON.stringify({ recipients: [`agent:${alphaSubject}`], content: { text: 'Pong' }, inReplyTo: sent.id }),
    }, env)
    expect(reply.status).toBe(201)
    expect(await reply.json<{ direction: string; inReplyTo: string }>()).toMatchObject({
      direction: 'outbound',
      inReplyTo: sent.id,
    })
  })

  it('uses the production Realmroot service binding to provision a first-delivery mailbox', async () => {
    const senderSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc0'
    const wiredSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc2'
    const productionApp = createApp(authenticate)
    const response = await productionApp.request('https://inbox.test/api/messages', {
      method: 'POST',
      headers: headers(senderSubject, { 'Content-Type': 'application/json', 'Idempotency-Key': 'wired-message-0001' }),
      body: JSON.stringify({ recipients: [`agent:${wiredSubject}`], content: { text: 'First delivery' } }),
    }, env)

    expect(response.status).toBe(201)
    expect(await env.DB.prepare('SELECT id FROM mailbox WHERE agent_subject = ?').bind(wiredSubject).first()).not.toBeNull()
  })

  it('requires API version, idempotency, and conditional state writes', async () => {
    const missingVersion = await app.request('https://inbox.test/api/messages', {
      headers: { 'x-test-agent': alphaSubject, 'Request-Id': 'caller-controlled' },
    }, env)
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.headers.get('request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(missingVersion.headers.get('request-id')).not.toBe('caller-controlled')

    const missingKey = await app.request('https://inbox.test/api/messages', {
      method: 'POST', headers: headers(alphaSubject, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ recipients: [`agent:${betaSubject}`], content: { text: 'Ping' } }),
    }, env)
    expect(missingKey.status).toBe(400)

    const unknownRecipient = await app.request('https://inbox.test/api/messages', {
      method: 'POST', headers: headers(alphaSubject, { 'Content-Type': 'application/json', 'Idempotency-Key': 'unknown-agent-0001' }),
      body: JSON.stringify({ recipients: [`agent:${missingSubject}`], content: { text: 'Ping' } }),
    }, env)
    expect(unknownRecipient.status).toBe(404)
    expect(await env.DB.prepare('SELECT id FROM mailbox WHERE agent_subject = ?').bind(missingSubject).first()).toBeNull()

    const legacyRecipient = await app.request('https://inbox.test/api/messages', {
      method: 'POST', headers: headers(alphaSubject, { 'Content-Type': 'application/json', 'Idempotency-Key': 'legacy-agent-0001' }),
      body: JSON.stringify({ recipients: ['agent:agt_legacy'], content: { text: 'Ping' } }),
    }, env)
    expect(legacyRecipient.status).toBe(400)
  })

  it('accepts inbound Email Routing messages and protects their attachments [spec: inbox/email-inbound]', async () => {
    expect(await env.DB.prepare('SELECT id FROM mailbox WHERE agent_subject = ?').bind(emailSubject).first()).toBeNull()
    const raw = [
      'From: Human <human@example.com>',
      'To: email-agent@agents.test',
      'Subject: Email hello',
      'Message-ID: <email-1@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="agent-inbox-test"',
      '',
      '--agent-inbox-test',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello from email.',
      '--agent-inbox-test',
      'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="note.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'bm90ZQ==',
      '--agent-inbox-test--',
      '',
    ].join('\r\n')
    const encoded = new TextEncoder().encode(raw)
    const routed: ForwardableEmailMessage = {
      from: 'human@example.com',
      to: 'email-agent@agents.test',
      raw: new Response(encoded).body!,
      rawSize: encoded.byteLength,
      headers: new Headers({ 'Message-ID': '<email-1@example.com>' }),
      setReject: (reason) => { throw new Error(`Unexpected rejection: ${reason}`) },
      forward: async () => ({ messageId: 'unused' }),
      reply: async () => ({ messageId: 'unused' }),
    }
    await receiveEmail(routed, env, agentDirectory)
    expect(await env.DB.prepare('SELECT id FROM mailbox WHERE agent_subject = ?').bind(emailSubject).first()).not.toBeNull()

    const inbox = await app.request('https://inbox.test/api/messages?direction=inbound', { headers: headers(emailSubject) }, env)
    const result = await inbox.json<{ items: Array<{ id: string; transport: string; sender: { address: string }; attachments: Array<{ id: string }> }> }>()
    expect(result.items[0]).toMatchObject({ transport: 'email', sender: { address: 'human@example.com' } })
    expect(result.items[0]?.attachments).toHaveLength(1)

    const message = result.items[0]!
    const attachment = await app.request(`https://inbox.test/api/messages/${message.id}/attachments/${message.attachments[0]!.id}`, { headers: headers(emailSubject) }, env)
    expect(attachment.status).toBe(200)
    expect(await attachment.text()).toBe('note')
  })
})
