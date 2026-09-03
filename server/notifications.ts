import { decryptDeliverySecret } from './delivery-secret'

const MAX_ATTEMPTS = 8
const CLAIM_LIMIT = 25
const LEASE_MILLISECONDS = 30_000
const DELIVERY_TIMEOUT_MILLISECONDS = 10_000
const TERMINAL_RETENTION_DAYS = 30
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 21_600, 86_400, 86_400, 86_400] as const

interface ClaimedEventRow {
  id: string
  subscription_id: string
  type: 'message.created'
  agent_id: string
  message_id: string
  routing_key: string | null
  occurred_at: string
  attempt_count: number
  delivery_url: string
  secret_ciphertext: string
  secret_nonce: string
}

export interface NotificationEvent {
  eventId: string
  type: 'message.created'
  subscriptionId: string
  agentId: string
  messageId: string
  routingKey?: string
  occurredAt: string
}

export interface NotificationTransport {
  send(url: string, token: string, event: NotificationEvent): Promise<number>
}

export function enqueueNotificationStatement(
  db: D1Database,
  mailboxId: string,
  agentId: string,
  messageId: string,
  routingKey: string | null,
  occurredAt: string,
) {
  return db.prepare(`
    INSERT OR IGNORE INTO notification_event
      (id, subscription_id, type, agent_id, message_id, routing_key, occurred_at, status,
       attempt_count, next_attempt_at, created_at, updated_at)
    SELECT 'evt_' || lower(hex(randomblob(16))), s.id, 'message.created', ?, ?, ?, ?, 'pending', 0, ?, ?, ?
    FROM subscription s
    WHERE s.mailbox_id = ?
      AND EXISTS (SELECT 1 FROM json_each(s.event_types) WHERE value = 'message.created')
  `).bind(agentId, messageId, routingKey, occurredAt, occurredAt, occurredAt, occurredAt, mailboxId)
}

export function enqueueServiceNotificationStatement(
  db: D1Database,
  mailboxId: string,
  agentId: string,
  messageId: string,
  routingKey: string | null,
  occurredAt: string,
  clientId: string,
  idempotencyKey: string,
  requestHash: string,
) {
  return db.prepare(`
    INSERT OR IGNORE INTO notification_event
      (id, subscription_id, type, agent_id, message_id, routing_key, occurred_at, status,
       attempt_count, next_attempt_at, created_at, updated_at)
    SELECT 'evt_' || lower(hex(randomblob(16))), s.id, 'message.created', ?, ?, ?, ?, 'pending', 0, ?, ?, ?
    FROM subscription s
    WHERE s.mailbox_id = ?
      AND EXISTS (SELECT 1 FROM json_each(s.event_types) WHERE value = 'message.created')
      AND EXISTS (
        SELECT 1 FROM service_idempotency_record reservation
        WHERE reservation.client_id = ? AND reservation.key = ? AND reservation.request_hash = ?
      )
  `).bind(agentId, messageId, routingKey, occurredAt, occurredAt, occurredAt, occurredAt, mailboxId, clientId, idempotencyKey, requestHash)
}

export async function deliverDueNotifications(
  env: { DB: D1Database; DELIVERY_SECRET_KEY: string },
  transport: NotificationTransport = createHttpNotificationTransport(),
  now = new Date(),
) {
  const leaseId = crypto.randomUUID()
  const nowValue = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MILLISECONDS).toISOString()
  await env.DB.prepare(`
    UPDATE notification_event
    SET status = 'delivering', attempt_count = attempt_count + 1, lease_id = ?, lease_expires_at = ?, updated_at = ?
    WHERE id IN (
      SELECT id FROM notification_event
      WHERE (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'delivering' AND lease_expires_at <= ?)
      ORDER BY next_attempt_at, id
      LIMIT ?
    )
  `).bind(leaseId, leaseExpiresAt, nowValue, nowValue, nowValue, CLAIM_LIMIT).run()
  const claimed = await env.DB.prepare(`
    SELECT e.*, s.delivery_url, s.secret_ciphertext, s.secret_nonce
    FROM notification_event e JOIN subscription s ON s.id = e.subscription_id
    WHERE e.lease_id = ? AND e.status = 'delivering'
    ORDER BY e.id
  `).bind(leaseId).all<ClaimedEventRow>()

  const results = await Promise.all(claimed.results.map((row) => deliverClaimed(env, transport, leaseId, row, now)))
  return {
    claimed: results.length,
    delivered: results.filter((result) => result === 'delivered').length,
    retrying: results.filter((result) => result === 'retrying').length,
    failed: results.filter((result) => result === 'failed').length,
  }
}

export function createHttpNotificationTransport(fetcher: typeof fetch = fetch): NotificationTransport {
  return {
    async send(url, token, event) {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MILLISECONDS),
        redirect: 'manual',
      })
      return response.status
    },
  }
}

async function deliverClaimed(
  env: { DB: D1Database; DELIVERY_SECRET_KEY: string },
  transport: NotificationTransport,
  leaseId: string,
  row: ClaimedEventRow,
  now: Date,
): Promise<'delivered' | 'retrying' | 'failed'> {
  const started = Date.now()
  let httpStatus: number | null = null
  let result: 'delivered' | 'retrying' | 'failed'
  let errorClassification: string | null = null
  let secretDecrypted = false
  try {
    const token = await decryptDeliverySecret(env.DELIVERY_SECRET_KEY, row.subscription_id, {
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
    })
    secretDecrypted = true
    httpStatus = await transport.send(row.delivery_url, token, {
      eventId: row.id,
      type: row.type,
      subscriptionId: row.subscription_id,
      agentId: row.agent_id,
      messageId: row.message_id,
      ...(row.routing_key !== null ? { routingKey: row.routing_key } : {}),
      occurredAt: row.occurred_at,
    })
    if (httpStatus >= 200 && httpStatus < 300) result = 'delivered'
    else if (httpStatus === 429 || httpStatus >= 500) result = row.attempt_count >= MAX_ATTEMPTS ? 'failed' : 'retrying'
    else result = 'failed'
  } catch (error) {
    errorClassification = secretDecrypted ? 'transport-error' : 'secret-decryption-failed'
    result = errorClassification === 'secret-decryption-failed' || row.attempt_count >= MAX_ATTEMPTS ? 'failed' : 'retrying'
  }

  const updatedAt = new Date().toISOString()
  let update: D1Result<unknown>
  if (result === 'delivered') {
    update = await env.DB.prepare(`
      UPDATE notification_event
      SET status = 'delivered', delivered_at = ?, lease_id = NULL, lease_expires_at = NULL,
          last_http_status = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).bind(updatedAt, httpStatus, updatedAt, row.id, leaseId).run()
  } else if (result === 'retrying') {
    const delay = RETRY_DELAYS_SECONDS[Math.min(row.attempt_count - 1, RETRY_DELAYS_SECONDS.length - 1)]!
    const nextAttemptAt = new Date(now.getTime() + delay * 1000).toISOString()
    update = await env.DB.prepare(`
      UPDATE notification_event
      SET status = 'pending', next_attempt_at = ?, lease_id = NULL, lease_expires_at = NULL,
          last_http_status = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).bind(nextAttemptAt, httpStatus, errorClassification, updatedAt, row.id, leaseId).run()
  } else {
    update = await env.DB.prepare(`
      UPDATE notification_event
      SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
          last_http_status = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).bind(httpStatus, errorClassification, updatedAt, row.id, leaseId).run()
  }
  if (update.meta.changes !== 1) throw new Error('Notification delivery lease was lost before finalization.')
  console.log(JSON.stringify({
    event: 'notification_delivery_completed',
    eventId: row.id,
    subscriptionId: row.subscription_id,
    attempt: row.attempt_count,
    result,
    httpStatus,
    errorClassification,
    durationMs: Date.now() - started,
  }))
  return result
}

export async function deleteRetainedNotificationEvents(db: D1Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - TERMINAL_RETENTION_DAYS * 86_400_000).toISOString()
  const result = await db.prepare(`
    DELETE FROM notification_event
    WHERE id IN (
      SELECT id FROM notification_event
      WHERE status IN ('delivered', 'failed') AND updated_at <= ?
      ORDER BY updated_at
      LIMIT 100
    )
  `).bind(cutoff).run()
  return result.meta.changes
}
