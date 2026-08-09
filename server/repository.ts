import type { AgentPrincipal } from './auth'
import type { AgentDirectory, AgentIdentity } from './agent-directory'
import type { CreateMessageInput, UpdateMailboxInput, UpdateMessageInput } from '../shared/contracts'
import { conflict, forbidden, notFound, preconditionFailed, preconditionRequired } from './errors'

export interface Mailbox {
  id: string
  agentIssuer: string
  agentSubject: string
  stableAddress: string
  aliasAddress: string | null
  version: number
  createdAt: string
  updatedAt: string
}

interface MailboxRow {
  id: string
  agent_issuer: string
  agent_subject: string
  stable_address: string
  alias_address: string | null
  version: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  sender_mailbox_id: string | null
  sender_kind: 'agent' | 'email'
  sender_address: string
  subject: string | null
  text_content: string | null
  html_content: string | null
  in_reply_to: string | null
  transport: 'agent' | 'email'
  created_at: string
  direction: 'inbound' | 'outbound' | 'both'
  state: 'unread' | 'read' | 'archived' | null
  recipient_version: number | null
}

interface RecipientRow {
  address: string
  delivery_status: 'pending' | 'delivered' | 'failed'
}

interface AttachmentRow {
  id: string
  filename: string | null
  media_type: string
  disposition: string | null
  content_id: string | null
  size: number
}

export interface MessageRepresentation {
  id: string
  direction: 'inbound' | 'outbound' | 'both'
  state: 'unread' | 'read' | 'archived' | null
  sender: { kind: 'agent' | 'email'; address: string }
  recipients: Array<{ address: string; deliveryStatus: 'pending' | 'delivered' | 'failed' }>
  subject: string | null
  content: { text?: string; html?: string }
  inReplyTo: string | null
  transport: 'agent' | 'email'
  attachments: Array<{
    id: string
    filename: string | null
    mediaType: string
    disposition: string | null
    contentId: string | null
    size: number
    url: string
  }>
  createdAt: string
  links: { self: string; mailbox: string }
}

export async function getOrCreateMailbox(db: D1Database, principal: AgentPrincipal, emailDomain: string) {
  return getOrCreateMailboxForAgent(db, principal.agent, emailDomain)
}

export async function getOrCreateMailboxForAgent(db: D1Database, agent: AgentIdentity, emailDomain: string) {
  const id = `mbx_${await digest(`${agent.issuer}\n${agent.subject}`, 32)}`
  const now = new Date().toISOString()
  const local = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(agent.subject)
    ? agent.subject.toLowerCase()
    : `agt-${await digest(agent.subject, 24)}`
  await db.prepare(`
    INSERT OR IGNORE INTO mailbox
      (id, agent_issuer, agent_subject, stable_address, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, agent.issuer, agent.subject, `${local}@${emailDomain}`.toLowerCase(), now, now).run()
  const row = await db.prepare('SELECT * FROM mailbox WHERE agent_issuer = ? AND agent_subject = ?')
    .bind(agent.issuer, agent.subject).first<MailboxRow>()
  if (!row) throw new Error('Mailbox provisioning did not produce a mailbox.')
  return mailbox(row)
}

export async function updateMailbox(
  db: D1Database,
  current: Mailbox,
  input: UpdateMailboxInput,
  ifMatch: string | undefined,
  emailDomain: string,
) {
  requireMatch(ifMatch, mailboxEtag(current))
  const aliasAddress = input.alias === null ? null : `${input.alias}@${emailDomain}`.toLowerCase()
  if (aliasAddress === current.stableAddress) throw conflict('The alias duplicates the stable mailbox address.')
  if (aliasAddress) {
    const unavailable = await db.prepare(`
      SELECT address FROM retired_alias WHERE address = ?
      UNION ALL SELECT stable_address FROM mailbox WHERE stable_address = ? AND id <> ?
      UNION ALL SELECT alias_address FROM mailbox WHERE alias_address = ? AND id <> ?
      LIMIT 1
    `).bind(aliasAddress, aliasAddress, current.id, aliasAddress, current.id).first()
    if (unavailable) throw conflict('The requested alias is unavailable.')
  }
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  if (current.aliasAddress && current.aliasAddress !== aliasAddress) {
    statements.push(db.prepare('INSERT OR IGNORE INTO retired_alias (address, retired_at) VALUES (?, ?)').bind(current.aliasAddress, now))
  }
  statements.push(db.prepare(`
    UPDATE mailbox SET alias_address = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(aliasAddress, now, current.id, current.version))
  const results = await db.batch(statements)
  if (results.at(-1)?.meta.changes !== 1) throw preconditionFailed('The mailbox changed before this update.')
  const updated = await db.prepare('SELECT * FROM mailbox WHERE id = ?').bind(current.id).first<MailboxRow>()
  if (!updated) throw new Error('Updated mailbox was not found.')
  return mailbox(updated)
}

export async function createMessage(
  db: D1Database,
  sender: Mailbox,
  principal: AgentPrincipal,
  origin: string,
  input: CreateMessageInput,
  idempotencyKey: string,
  agentDirectory: AgentDirectory,
  emailDomain: string,
) {
  const requestHash = await digest(JSON.stringify(input), 64)
  const id = `msg_${await digest(`${sender.id}\n${idempotencyKey}`, 32)}`
  const existing = await db.prepare('SELECT request_hash, message_id FROM idempotency_record WHERE mailbox_id = ? AND key = ?')
    .bind(sender.id, idempotencyKey).first<{ request_hash: string; message_id: string }>()
  if (existing) {
    if (existing.request_hash !== requestHash) throw conflict('The Idempotency-Key was already used with different content.')
    return { message: await getMessage(db, sender.id, existing.message_id, origin), replayed: true }
  }
  if (input.inReplyTo) await getMessage(db, sender.id, input.inReplyTo, origin)

  const recipientSubjects = [...new Set(input.recipients.map((address) => address.slice('agent:'.length)))]
  const recipients: Mailbox[] = []
  for (const subject of recipientSubjects) {
    let recipient = await mailboxByAgent(db, principal.agent.issuer, subject)
    if (!recipient) {
      const identity = await agentDirectory.find(principal.agent.issuer, subject)
      if (!identity) throw notFound(`Recipient agent:${subject} does not exist.`)
      recipient = await getOrCreateMailboxForAgent(db, identity, emailDomain)
    }
    recipients.push(recipient)
  }
  const now = new Date().toISOString()
  const statements = [
    db.prepare(`
      INSERT OR IGNORE INTO message
        (id, sender_mailbox_id, sender_kind, sender_address, subject, text_content, html_content, in_reply_to, transport, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, 'agent', ?)
    `).bind(id, sender.id, `agent:${principal.agent.subject}`, input.subject ?? null, input.content.text ?? null, input.content.html ?? null, input.inReplyTo ?? null, now),
    ...recipients.map((recipient) => db.prepare(`
      INSERT OR IGNORE INTO message_recipient
        (message_id, mailbox_id, address, state, delivery_status, received_at)
      VALUES (?, ?, ?, 'unread', 'delivered', ?)
    `).bind(id, recipient.id, `agent:${recipient.agentSubject}`, now)),
    db.prepare(`
      INSERT OR IGNORE INTO idempotency_record (mailbox_id, key, request_hash, message_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(sender.id, idempotencyKey, requestHash, id, now),
  ]
  await db.batch(statements)
  const record = await db.prepare('SELECT request_hash, message_id FROM idempotency_record WHERE mailbox_id = ? AND key = ?')
    .bind(sender.id, idempotencyKey).first<{ request_hash: string; message_id: string }>()
  if (!record || record.request_hash !== requestHash) throw conflict('The Idempotency-Key was concurrently used with different content.')
  return { message: await getMessage(db, sender.id, record.message_id, origin), replayed: record.message_id !== id }
}

export async function listMessages(
  db: D1Database,
  mailboxId: string,
  origin: string,
  options: { direction?: 'inbound' | 'outbound' | undefined; state?: 'unread' | 'read' | 'archived' | undefined; pageSize: number; pageToken?: string | undefined },
) {
  const cursor = options.pageToken ? decodeCursor(options.pageToken) : null
  const conditions = ['(m.sender_mailbox_id = ? OR mr.mailbox_id = ?)']
  const values: unknown[] = [mailboxId, mailboxId]
  if (options.direction === 'inbound') conditions.push('mr.mailbox_id IS NOT NULL')
  if (options.direction === 'outbound') conditions.push('m.sender_mailbox_id = ?'), values.push(mailboxId)
  if (options.state) conditions.push('mr.state = ?'), values.push(options.state)
  if (cursor) {
    conditions.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))')
    values.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }
  values.push(options.pageSize + 1)
  const result = await db.prepare(`
    SELECT m.*,
      CASE WHEN m.sender_mailbox_id = ? AND mr.mailbox_id IS NOT NULL THEN 'both'
           WHEN m.sender_mailbox_id = ? THEN 'outbound' ELSE 'inbound' END AS direction,
      mr.state, mr.version AS recipient_version
    FROM message m
    LEFT JOIN message_recipient mr ON mr.message_id = m.id AND mr.mailbox_id = ?
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).bind(mailboxId, mailboxId, mailboxId, ...values).all<MessageRow>()
  const rows = result.results.slice(0, options.pageSize)
  const items = await Promise.all(rows.map((row) => representMessage(db, row, origin)))
  const last = rows.at(-1)
  const nextPageToken = result.results.length > options.pageSize && last
    ? encodeCursor({ createdAt: last.created_at, id: last.id })
    : undefined
  return { items, pagination: { pageSize: options.pageSize, ...(nextPageToken ? { nextPageToken } : {}) } }
}

export async function getMessage(db: D1Database, mailboxId: string, messageId: string, origin: string) {
  const row = await db.prepare(`
    SELECT m.*,
      CASE WHEN m.sender_mailbox_id = ? AND mr.mailbox_id IS NOT NULL THEN 'both'
           WHEN m.sender_mailbox_id = ? THEN 'outbound' ELSE 'inbound' END AS direction,
      mr.state, mr.version AS recipient_version
    FROM message m
    LEFT JOIN message_recipient mr ON mr.message_id = m.id AND mr.mailbox_id = ?
    WHERE m.id = ? AND (m.sender_mailbox_id = ? OR mr.mailbox_id = ?)
  `).bind(mailboxId, mailboxId, mailboxId, messageId, mailboxId, mailboxId).first<MessageRow>()
  if (!row) throw notFound('Message not found.')
  return representMessage(db, row, origin)
}

export async function updateMessage(
  db: D1Database,
  mailboxId: string,
  messageId: string,
  input: UpdateMessageInput,
  ifMatch: string | undefined,
  origin: string,
) {
  const current = await getMessageRow(db, mailboxId, messageId)
  if (current.recipient_version === null) throw forbidden('Only an inbound message has mailbox-local state.')
  requireMatch(ifMatch, messageEtag(current.recipient_version)!)
  const updated = await db.prepare(`
    UPDATE message_recipient SET state = ?, version = version + 1
    WHERE message_id = ? AND mailbox_id = ? AND version = ?
  `).bind(input.state, messageId, mailboxId, current.recipient_version).run()
  if (updated.meta.changes !== 1) throw preconditionFailed('The message state changed before this update.')
  return getMessage(db, mailboxId, messageId, origin)
}

export async function getAttachment(db: D1Database, mailboxId: string, messageId: string, attachmentId: string) {
  await getMessageRow(db, mailboxId, messageId)
  const row = await db.prepare('SELECT * FROM attachment WHERE id = ? AND message_id = ?')
    .bind(attachmentId, messageId).first<AttachmentRow & { object_key: string }>()
  if (!row) throw notFound('Attachment not found.')
  return row
}

export async function mailboxByEmail(db: D1Database, address: string) {
  const row = await db.prepare('SELECT * FROM mailbox WHERE stable_address = ? OR alias_address = ?')
    .bind(address.toLowerCase(), address.toLowerCase()).first<MailboxRow>()
  return row ? mailbox(row) : null
}

export async function mailboxByAgent(db: D1Database, issuer: string, subject: string) {
  const row = await db.prepare('SELECT * FROM mailbox WHERE agent_issuer = ? AND agent_subject = ?')
    .bind(issuer, subject).first<MailboxRow>()
  return row ? mailbox(row) : null
}

export function mailboxRepresentation(value: Mailbox, origin: string) {
  return {
    id: value.id,
    agent: { issuer: value.agentIssuer, subject: value.agentSubject },
    addresses: {
      stable: value.stableAddress,
      alias: value.aliasAddress,
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    links: { self: `${origin}/api/mailbox`, messages: `${origin}/api/messages` },
  }
}

export const mailboxEtag = (value: Mailbox) => `"mailbox-${value.version}"`
export const messageEtag = (version: number | null) => version === null ? undefined : `"message-${version}"`

async function getMessageRow(db: D1Database, mailboxId: string, messageId: string) {
  const row = await db.prepare(`
    SELECT m.*,
      CASE WHEN m.sender_mailbox_id = ? AND mr.mailbox_id IS NOT NULL THEN 'both'
           WHEN m.sender_mailbox_id = ? THEN 'outbound' ELSE 'inbound' END AS direction,
      mr.state, mr.version AS recipient_version
    FROM message m LEFT JOIN message_recipient mr ON mr.message_id = m.id AND mr.mailbox_id = ?
    WHERE m.id = ? AND (m.sender_mailbox_id = ? OR mr.mailbox_id = ?)
  `).bind(mailboxId, mailboxId, mailboxId, messageId, mailboxId, mailboxId).first<MessageRow>()
  if (!row) throw notFound('Message not found.')
  return row
}

async function representMessage(db: D1Database, row: MessageRow, origin: string): Promise<MessageRepresentation> {
  const [recipientResult, attachmentResult] = await Promise.all([
    db.prepare('SELECT address, delivery_status FROM message_recipient WHERE message_id = ? ORDER BY address').bind(row.id).all<RecipientRow>(),
    db.prepare('SELECT id, filename, media_type, disposition, content_id, size FROM attachment WHERE message_id = ? ORDER BY id').bind(row.id).all<AttachmentRow>(),
  ])
  return {
    id: row.id,
    direction: row.direction,
    state: row.state,
    sender: { kind: row.sender_kind, address: row.sender_address },
    recipients: recipientResult.results.map((recipient) => ({ address: recipient.address, deliveryStatus: recipient.delivery_status })),
    subject: row.subject,
    content: {
      ...(row.text_content !== null ? { text: row.text_content } : {}),
      ...(row.html_content !== null ? { html: row.html_content } : {}),
    },
    inReplyTo: row.in_reply_to,
    transport: row.transport,
    attachments: attachmentResult.results.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mediaType: attachment.media_type,
      disposition: attachment.disposition,
      contentId: attachment.content_id,
      size: attachment.size,
      url: `${origin}/api/messages/${row.id}/attachments/${attachment.id}`,
    })),
    createdAt: row.created_at,
    links: { self: `${origin}/api/messages/${row.id}`, mailbox: `${origin}/api/mailbox` },
  }
}

function mailbox(row: MailboxRow): Mailbox {
  return {
    id: row.id,
    agentIssuer: row.agent_issuer,
    agentSubject: row.agent_subject,
    stableAddress: row.stable_address,
    aliasAddress: row.alias_address,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireMatch(value: string | undefined, expected: string) {
  if (!value) throw preconditionRequired('If-Match is required.')
  if (value !== expected) throw preconditionFailed('If-Match does not match the current representation.')
}

function encodeCursor(value: { createdAt: string; id: string }) {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeCursor(value: string) {
  try {
    const json = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || !('createdAt' in parsed) || !('id' in parsed) ||
      typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error('invalid')
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    throw conflict('The pageToken is invalid.')
  }
}

async function digest(value: string, length: number) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length)
}
