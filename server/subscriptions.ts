import type { AgentDirectory } from './agent-directory'
import type { ServicePrincipal } from './auth'
import { encryptDeliverySecret } from './delivery-secret'
import { badRequest, notFound, preconditionFailed, preconditionRequired } from './errors'
import { getOrCreateMailboxForAgent } from './repository'
import type { ReplaceSubscriptionInput } from '../shared/contracts'

interface SubscriptionRow {
  id: string
  owner_issuer: string
  owner_subject: string
  owner_client_id: string
  mailbox_id: string
  agent_subject: string
  event_types: string
  delivery_url: string
  version: number
  created_at: string
  updated_at: string
}

export interface SubscriptionRepresentation {
  id: string
  agentId: string
  events: string[]
  delivery: { url: string; authorization: { scheme: 'bearer' } }
  createdAt: string
  updatedAt: string
  links: { self: string }
}

export async function listSubscriptions(
  db: D1Database,
  principal: ServicePrincipal,
  origin: string,
  options: { pageSize: number; pageToken?: string | undefined },
) {
  const cursor = options.pageToken ? decodeCursor(options.pageToken) : null
  const values: unknown[] = [principal.issuer, principal.subject, principal.clientId]
  const cursorCondition = cursor ? 'AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))' : ''
  if (cursor) values.push(cursor.createdAt, cursor.createdAt, cursor.id)
  values.push(options.pageSize + 1)
  const result = await db.prepare(`
    SELECT s.*, m.agent_subject
    FROM subscription s JOIN mailbox m ON m.id = s.mailbox_id
    WHERE s.owner_issuer = ? AND s.owner_subject = ? AND s.owner_client_id = ?
      ${cursorCondition}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ?
  `).bind(...values).all<SubscriptionRow>()
  const rows = result.results.slice(0, options.pageSize)
  const last = rows.at(-1)
  const nextPageToken = result.results.length > options.pageSize && last
    ? encodeCursor({ createdAt: last.created_at, id: last.id })
    : undefined
  return {
    items: rows.map((row) => subscriptionRepresentation(row, origin)),
    pagination: { pageSize: options.pageSize, ...(nextPageToken ? { nextPageToken } : {}) },
  }
}

export async function getSubscription(db: D1Database, principal: ServicePrincipal, subscriptionId: string, origin: string) {
  const row = await subscriptionRow(db, principal, subscriptionId)
  if (!row) throw notFound('Subscription not found.')
  return { subscription: subscriptionRepresentation(row, origin), etag: subscriptionEtag(row.version) }
}

export async function replaceSubscription(
  db: D1Database,
  principal: ServicePrincipal,
  subscriptionId: string,
  input: ReplaceSubscriptionInput,
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
  agentDirectory: AgentDirectory,
  emailDomain: string,
  origin: string,
  secretKey: string,
) {
  const current = await subscriptionRow(db, principal, subscriptionId)
  if (current) {
    requireMatch(ifMatch, subscriptionEtag(current.version))
    if (ifNoneMatch !== undefined) throw preconditionFailed('If-None-Match cannot replace an existing Subscription.')
  } else if (ifNoneMatch !== '*') {
    throw preconditionRequired('If-None-Match: * is required to create a Subscription.')
  }
  const identity = await agentDirectory.find(principal.issuer, input.agentId)
  if (!identity) throw notFound(`Agent ${input.agentId} does not exist.`)
  const mailbox = await getOrCreateMailboxForAgent(db, identity, emailDomain)
  const encrypted = await encryptDeliverySecret(secretKey, subscriptionId, input.delivery.authorization.token)
  const now = new Date().toISOString()
  const eventTypes = JSON.stringify(input.events)
  if (current) {
    const result = await db.prepare(`
      UPDATE subscription
      SET mailbox_id = ?, event_types = ?, delivery_url = ?, authorization_scheme = 'bearer',
          secret_ciphertext = ?, secret_nonce = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_issuer = ? AND owner_subject = ? AND owner_client_id = ? AND version = ?
    `).bind(
      mailbox.id, eventTypes, input.delivery.url, encrypted.ciphertext, encrypted.nonce, now,
      subscriptionId, principal.issuer, principal.subject, principal.clientId, current.version,
    ).run()
    if (result.meta.changes !== 1) throw preconditionFailed('The Subscription changed before this replacement.')
  } else {
    const result = await db.prepare(`
      INSERT OR IGNORE INTO subscription
        (id, owner_issuer, owner_subject, owner_client_id, mailbox_id, event_types, delivery_url,
         authorization_scheme, secret_ciphertext, secret_nonce, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'bearer', ?, ?, ?, ?)
    `).bind(
      subscriptionId, principal.issuer, principal.subject, principal.clientId, mailbox.id,
      eventTypes, input.delivery.url, encrypted.ciphertext, encrypted.nonce, now, now,
    ).run()
    if (result.meta.changes !== 1) throw preconditionFailed('The Subscription already exists.')
  }
  const updated = await getSubscription(db, principal, subscriptionId, origin)
  return { ...updated, created: current === null }
}

export async function deleteSubscription(
  db: D1Database,
  principal: ServicePrincipal,
  subscriptionId: string,
  ifMatch: string | undefined,
) {
  const current = await subscriptionRow(db, principal, subscriptionId)
  if (!current) throw notFound('Subscription not found.')
  requireMatch(ifMatch, subscriptionEtag(current.version))
  const result = await db.prepare(`
    DELETE FROM subscription
    WHERE id = ? AND owner_issuer = ? AND owner_subject = ? AND owner_client_id = ? AND version = ?
  `).bind(subscriptionId, principal.issuer, principal.subject, principal.clientId, current.version).run()
  if (result.meta.changes < 1) throw preconditionFailed('The Subscription changed before deletion.')
}

export const subscriptionEtag = (version: number) => `"subscription-${version}"`

async function subscriptionRow(db: D1Database, principal: ServicePrincipal, subscriptionId: string) {
  return db.prepare(`
    SELECT s.*, m.agent_subject
    FROM subscription s JOIN mailbox m ON m.id = s.mailbox_id
    WHERE s.id = ? AND s.owner_issuer = ? AND s.owner_subject = ? AND s.owner_client_id = ?
  `).bind(subscriptionId, principal.issuer, principal.subject, principal.clientId).first<SubscriptionRow>()
}

function subscriptionRepresentation(row: SubscriptionRow, origin: string): SubscriptionRepresentation {
  return {
    id: row.id,
    agentId: row.agent_subject,
    events: JSON.parse(row.event_types) as string[],
    delivery: { url: row.delivery_url, authorization: { scheme: 'bearer' } },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    links: { self: `${origin}/api/subscriptions/${row.id}` },
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
    const parsed: unknown = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')))
    if (!parsed || typeof parsed !== 'object' || !('createdAt' in parsed) || !('id' in parsed) ||
      typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error('invalid')
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    throw badRequest('The pageToken is invalid.')
  }
}
