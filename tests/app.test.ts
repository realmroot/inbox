import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app'
import type { Authenticator, MessageAuthenticator, ServiceAuthenticator } from '../server/auth'
import type { AgentDirectory } from '../server/agent-directory'
import { receiveEmail } from '../server/email'
import { API_VERSION } from '../shared/contracts'
import { createHttpNotificationTransport, deliverDueNotifications } from '../server/notifications'

const authenticate: Authenticator = async (request, runtimeEnv) => {
  const subject = request.headers.get('x-test-agent')
  if (!subject) throw new Error('x-test-agent is required in tests')
  return {
    owner: { issuer: runtimeEnv.OIDC_ISSUER, subject: `controller-${subject}` },
    agent: { issuer: runtimeEnv.OIDC_ISSUER, subject },
    scopes: [],
  }
}

const authenticateService: ServiceAuthenticator = async (_request, runtimeEnv) => ({
  issuer: runtimeEnv.OIDC_ISSUER,
  subject: 'agency-service',
  clientId: runtimeEnv.AGENCY_CLIENT_ID,
  scopes: ['subscriptions:read', 'subscriptions:manage'],
})

const authenticateMessages: MessageAuthenticator = async (request, runtimeEnv, operationId) => {
  if (request.headers.get('authorization') !== 'Bearer machine-message-token' || operationId !== 'createMessage') {
    throw new Error('machine message authentication is required in tests')
  }
  return {
    issuer: runtimeEnv.OIDC_ISSUER,
    subject: 'agent-kanban-service',
    clientId: 'agent-kanban',
    scopes: ['messages:create'],
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
const app = createApp(authenticate, () => agentDirectory, authenticateService)
const machineMessageApp = createApp(authenticate, () => agentDirectory, authenticateService, authenticateMessages)
const headers = (agent: string, extra: HeadersInit = {}) => ({
  'API-Version': API_VERSION,
  'x-test-agent': agent,
  ...Object.fromEntries(new Headers(extra)),
})
const serviceHeaders = (extra: HeadersInit = {}) => ({
  'API-Version': API_VERSION,
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
        'subscriptions:read',
        'subscriptions:manage',
      ],
    })

    const response = await app.request('https://inbox.test/api/openapi.json', {}, env)
    const document = await response.json<Record<string, unknown>>()
    const paths = document.paths as Record<string, Record<string, { operationId?: string; 'x-cli-name'?: string; security?: Array<Record<string, string[]>> }>>
    expect(Object.keys(paths)).toEqual([
      '/mailbox',
      '/messages',
      '/messages/{messageId}',
      '/messages/{messageId}/attachments/{attachmentId}',
      '/subscriptions',
      '/subscriptions/{subscriptionId}',
    ])
    expect(paths['/messages']?.post?.operationId).toBe('createMessage')
    expect(paths['/messages']?.post?.['x-cli-name']).toBe('send')
    expect(paths['/messages']?.post?.security).toEqual([
      { RealmrootOAuth: ['messages:create'] },
      { RealmrootServiceOAuth: ['messages:create'] },
    ])
    expect(paths['/subscriptions/{subscriptionId}']?.put?.security).toEqual([{ RealmrootServiceOAuth: ['subscriptions:manage'] }])
    expect(Object.keys(paths).some((path) => /entries|inbox|outbox/.test(path))).toBe(false)
    expect(JSON.stringify(paths['/messages']?.post)).toContain('IdempotencyReplayed')
    expect(JSON.stringify(document)).toContain('"writeOnly":true')
  })

  it('manages write-only notification Subscriptions and retries one stable event at least once', async () => {
    const subscriptionId = 'sub_0123456789abcdef0123456789abcdef'
    const callbackToken = 'agency-callback-token-0123456789abcdef'
    const created = await app.request(`https://inbox.test/api/subscriptions/${subscriptionId}`, {
      method: 'PUT',
      headers: serviceHeaders({ 'Content-Type': 'application/json', 'If-None-Match': '*' }),
      body: JSON.stringify({
        agentId: betaSubject,
        events: ['message.created'],
        delivery: {
          url: 'https://agency.test/inbox-events',
          authorization: { scheme: 'bearer', token: callbackToken },
        },
      }),
    }, env)
    expect(created.status).toBe(201)
    expect(created.headers.get('etag')).toBe('"subscription-1"')
    const subscription = await created.json<Record<string, unknown>>()
    expect(subscription).toMatchObject({
      id: subscriptionId,
      agentId: betaSubject,
      events: ['message.created'],
      delivery: { url: 'https://agency.test/inbox-events', authorization: { scheme: 'bearer' } },
    })
    expect(JSON.stringify(subscription)).not.toContain(callbackToken)
    const secret = await env.DB.prepare('SELECT secret_ciphertext FROM subscription WHERE id = ?')
      .bind(subscriptionId).first<{ secret_ciphertext: string }>()
    expect(secret?.secret_ciphertext).not.toContain(callbackToken)

    const replacementToken = 'rotated-callback-token-0123456789abcdef'
    const replaced = await app.request(`https://inbox.test/api/subscriptions/${subscriptionId}`, {
      method: 'PUT',
      headers: serviceHeaders({ 'Content-Type': 'application/json', 'If-Match': created.headers.get('etag')! }),
      body: JSON.stringify({
        agentId: betaSubject,
        events: ['message.created'],
        delivery: {
          url: 'https://agency.test/inbox-events/v2',
          authorization: { scheme: 'bearer', token: replacementToken },
        },
      }),
    }, env)
    expect(replaced.status).toBe(200)
    expect(replaced.headers.get('etag')).toBe('"subscription-2"')
    expect(JSON.stringify(await replaced.json())).not.toContain(replacementToken)
    const listed = await app.request('https://inbox.test/api/subscriptions?pageSize=10', {
      headers: serviceHeaders(),
    }, env)
    expect(await listed.json()).toMatchObject({
      items: [{ id: subscriptionId, delivery: { authorization: { scheme: 'bearer' } } }],
      pagination: { pageSize: 10 },
    })
    const otherServiceApp = createApp(authenticate, () => agentDirectory, async (_request, runtimeEnv) => ({
      issuer: runtimeEnv.OIDC_ISSUER,
      subject: 'other-service',
      clientId: runtimeEnv.AGENCY_CLIENT_ID,
      scopes: ['subscriptions:read'],
    }))
    const concealed = await otherServiceApp.request(`https://inbox.test/api/subscriptions/${subscriptionId}`, {
      headers: serviceHeaders(),
    }, env)
    expect(concealed.status).toBe(404)

    const sent = await app.request('https://inbox.test/api/messages', {
      method: 'POST',
      headers: headers(alphaSubject, { 'Content-Type': 'application/json', 'Idempotency-Key': 'notification-message-0001' }),
      body: JSON.stringify({
        recipients: [`agent:${betaSubject}`],
        content: { text: 'Wake up' },
        routingKey: 'trigger_01HXYZ',
      }),
    }, env)
    expect(sent.status).toBe(201)
    const message = await sent.json<{ id: string; routingKey: string }>()
    expect(message.routingKey).toBe('trigger_01HXYZ')
    const pending = await env.DB.prepare('SELECT id, status FROM notification_event WHERE subscription_id = ?')
      .bind(subscriptionId).first<{ id: string; status: string }>()
    expect(pending?.status).toBe('pending')

    const requests: Array<{ url: string; headers: Headers; event: Record<string, unknown>; redirect?: RequestInit['redirect'] }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        event: JSON.parse(String(init?.body)) as Record<string, unknown>,
        redirect: init?.redirect,
      })
      return new Response(null, { status: requests.length === 1 ? 429 : 204 })
    })
    const transport = createHttpNotificationTransport(fetcher as typeof fetch)
    const firstAttempt = await deliverDueNotifications(env, transport, new Date(Date.now() + 1000))
    expect(firstAttempt).toMatchObject({ claimed: 1, retrying: 1 })
    const secondAttempt = await deliverDueNotifications(env, transport, new Date(Date.now() + 121_000))
    expect(secondAttempt).toMatchObject({ claimed: 1, delivered: 1 })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe('https://agency.test/inbox-events/v2')
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${replacementToken}`)
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(requests[0]?.redirect).toBe('manual')
    expect(requests[0]?.event).toMatchObject({
      eventId: pending?.id,
      type: 'message.created',
      subscriptionId,
      agentId: betaSubject,
      messageId: message.id,
      routingKey: 'trigger_01HXYZ',
    })
    expect(Object.keys(requests[0]!.event).sort()).toEqual([
      'agentId', 'eventId', 'messageId', 'occurredAt', 'routingKey', 'subscriptionId', 'type',
    ])
    expect(requests[1]?.event.eventId).toBe(requests[0]?.event.eventId)

    const read = await app.request(`https://inbox.test/api/subscriptions/${subscriptionId}`, {
      headers: serviceHeaders(),
    }, env)
    expect(JSON.stringify(await read.json())).not.toContain(callbackToken)
    expect(read.headers.get('etag')).toBe('"subscription-2"')
    const deleted = await app.request(`https://inbox.test/api/subscriptions/${subscriptionId}`, {
      method: 'DELETE', headers: serviceHeaders({ 'If-Match': read.headers.get('etag')! }),
    }, env)
    expect(deleted.status).toBe(204)
    expect(await env.DB.prepare('SELECT id FROM notification_event WHERE subscription_id = ?').bind(subscriptionId).first()).toBeNull()
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

  it('creates a service-sender Message with machine Bearer authority and preserves client idempotency', async () => {
    const request = {
      method: 'POST',
      headers: serviceHeaders({
        Authorization: 'Bearer machine-message-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'agent-kanban-assignment-0001',
      }),
      body: JSON.stringify({
        recipients: [`agent:${betaSubject}`],
        subject: 'Task assigned',
        content: { text: 'Open the assigned Task.' },
        routingKey: 'agent-kanban:task:task-a',
      }),
    }
    const created = await machineMessageApp.request('https://inbox.test/api/messages', request, env)
    expect(created.status).toBe(201)
    expect(created.headers.get('idempotency-replayed')).toBe('false')
    const serviceMessage = await created.json<{ id: string; sender: { kind: string; address: string }; direction: string }>()
    expect(serviceMessage).toMatchObject({
      direction: 'outbound',
      sender: { kind: 'service', address: 'service:agent-kanban' },
    })

    const received = await machineMessageApp.request('https://inbox.test/api/messages?direction=inbound', {
      headers: headers(betaSubject),
    }, env)
    expect(received.status).toBe(200)
    await expect(received.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: serviceMessage.id, direction: 'inbound', sender: serviceMessage.sender })],
    })

    const replay = await machineMessageApp.request('https://inbox.test/api/messages', request, env)
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    await expect(replay.json()).resolves.toEqual(serviceMessage)

    const conflictResponse = await machineMessageApp.request('https://inbox.test/api/messages', {
      ...request,
      body: JSON.stringify({ recipients: [`agent:${betaSubject}`], content: { text: 'Different content.' } }),
    }, env)
    expect(conflictResponse.status).toBe(409)
    await expect(conflictResponse.json()).resolves.toMatchObject({ status: 409, detail: expect.stringContaining('different content') })
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM message WHERE id = ?').bind(serviceMessage.id).first(),
    ).resolves.toEqual({ count: 1 })
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM service_idempotency_record WHERE client_id = ? AND key = ?')
        .bind('agent-kanban', 'agent-kanban-assignment-0001').first(),
    ).resolves.toEqual({ count: 1 })
    await expect(
      env.DB.prepare('SELECT client_id FROM service_message_sender WHERE message_id = ?').bind(serviceMessage.id).first(),
    ).resolves.toEqual({ client_id: 'agent-kanban' })
  })

  it('atomically chooses one concurrent service Message payload for the same client idempotency key', async () => {
    for (const [subscriptionId, agentId] of [
      ['sub_11111111111111111111111111111111', betaSubject],
      ['sub_22222222222222222222222222222222', emailSubject],
    ] as const) {
      const subscription = await machineMessageApp.request(`https://inbox.test/api/subscriptions/${subscriptionId}`, {
        method: 'PUT',
        headers: serviceHeaders({ 'Content-Type': 'application/json', 'If-None-Match': '*' }),
        body: JSON.stringify({
          agentId,
          events: ['message.created'],
          delivery: {
            url: `https://agency.test/${agentId}`,
            authorization: { scheme: 'bearer', token: 'callback-token-0123456789abcdef-extra' },
          },
        }),
      }, env)
      expect(subscription.status).toBe(201)
    }

    const key = 'concurrent-service-message-0001'
    const candidates = [
      { recipients: [`agent:${betaSubject}`], content: { text: 'Beta wins' }, routingKey: 'candidate-beta' },
      { recipients: [`agent:${emailSubject}`], content: { text: 'Email wins' }, routingKey: 'candidate-email' },
    ]
    const responses = await Promise.all(candidates.map((body) => machineMessageApp.request('https://inbox.test/api/messages', {
      method: 'POST',
      headers: serviceHeaders({
        Authorization: 'Bearer machine-message-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      }),
      body: JSON.stringify(body),
    }, env)))
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409])
    const winnerIndex = responses.findIndex(({ status }) => status === 201)
    const winner = await responses[winnerIndex]!.json<{ id: string; recipients: Array<{ address: string }> }>()
    const winnerRecipient = candidates[winnerIndex]!.recipients[0]!
    expect(winner.recipients).toEqual([{ address: winnerRecipient, deliveryStatus: 'delivered' }])

    await expect(
      env.DB.prepare('SELECT address FROM message_recipient WHERE message_id = ? ORDER BY address').bind(winner.id).all(),
    ).resolves.toMatchObject({ results: [{ address: winnerRecipient }] })
    await expect(
      env.DB.prepare('SELECT agent_id, message_id FROM notification_event WHERE message_id = ?').bind(winner.id).all(),
    ).resolves.toMatchObject({ results: [{ agent_id: winnerRecipient.slice('agent:'.length), message_id: winner.id }] })
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM service_idempotency_record WHERE client_id = ? AND key = ?')
        .bind('agent-kanban', key).first(),
    ).resolves.toEqual({ count: 1 })
  })

  it('atomically replays one concurrent service Message for the same client key and payload', async () => {
    const subscription = await machineMessageApp.request(
      'https://inbox.test/api/subscriptions/sub_33333333333333333333333333333333',
      {
        method: 'PUT',
        headers: serviceHeaders({ 'Content-Type': 'application/json', 'If-None-Match': '*' }),
        body: JSON.stringify({
          agentId: betaSubject,
          events: ['message.created'],
          delivery: {
            url: 'https://agency.test/concurrent-replay',
            authorization: { scheme: 'bearer', token: 'callback-token-0123456789abcdef-extra' },
          },
        }),
      },
      env,
    )
    expect(subscription.status).toBe(201)

    const body = JSON.stringify({
      recipients: [`agent:${betaSubject}`],
      content: { text: 'Create this service Message once.' },
      routingKey: 'concurrent-identical-payload',
    })
    const responses = await Promise.all(Array.from({ length: 2 }, () => machineMessageApp.request(
      'https://inbox.test/api/messages',
      {
        method: 'POST',
        headers: serviceHeaders({
          Authorization: 'Bearer machine-message-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'concurrent-identical-service-message-0001',
        }),
        body,
      },
      env,
    )))
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201])
    expect(responses.map((response) => response.headers.get('idempotency-replayed')).sort()).toEqual(['false', 'true'])
    const messages = await Promise.all(responses.map((response) => response.json<{ id: string }>()))
    expect(messages[1]).toEqual(messages[0])
    const messageId = messages[0]!.id

    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM message WHERE id = ?').bind(messageId).first(),
    ).resolves.toEqual({ count: 1 })
    for (const table of ['message_recipient', 'service_message_sender', 'notification_event'] as const) {
      await expect(
        env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE message_id = ?`).bind(messageId).first(),
      ).resolves.toEqual({ count: 1 })
    }
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
