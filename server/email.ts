import PostalMime from 'postal-mime'
import { createRealmrootAgentDirectory, stableAddressUsername, type AgentDirectory } from './agent-directory'
import { getOrCreateMailboxForAgent, mailboxByEmail } from './repository'

const MAX_EMAIL_BYTES = 10 * 1024 * 1024
const EMAIL_RETENTION_DAYS = 30

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Cloudflare.Env,
  agentDirectory: AgentDirectory = createRealmrootAgentDirectory(env.REALMROOT),
) {
  if (message.rawSize > MAX_EMAIL_BYTES) {
    message.setReject('Message exceeds the 10 MiB inbound limit.')
    return
  }
  let mailbox = await mailboxByEmail(env.DB, message.to)
  if (!mailbox) {
    const username = stableAddressUsername(message.to, env.EMAIL_DOMAIN)
    const identity = username ? await agentDirectory.findByUsername(env.OIDC_ISSUER, username) : null
    if (identity) mailbox = await getOrCreateMailboxForAgent(env.DB, identity, env.EMAIL_DOMAIN)
  }
  if (!mailbox) {
    message.setReject('Mailbox does not exist.')
    return
  }
  const raw = await new Response(message.raw).arrayBuffer()
  const parsed = await PostalMime.parse(raw)
  const providerReference = `${parsed.messageId ?? await digest(raw)}|${message.to.toLowerCase()}`
  const duplicate = await env.DB.prepare("SELECT id FROM message WHERE transport = 'email' AND transport_reference = ?")
    .bind(providerReference).first<{ id: string }>()
  if (duplicate) return

  const id = `msg_${await digest(providerReference, 32)}`
  const now = new Date()
  const expiresAt = new Date(now.getTime() + EMAIL_RETENTION_DAYS * 86400_000).toISOString()
  const reserved = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO message
        (id, sender_mailbox_id, sender_kind, sender_address, subject, text_content, html_content, in_reply_to, transport, transport_reference, expires_at, created_at)
      VALUES (?, NULL, 'email', ?, ?, ?, ?, NULL, 'email', ?, ?, ?)
    `).bind(id, message.from, parsed.subject ?? null, parsed.text ?? null, parsed.html || null, providerReference, expiresAt, now.toISOString()),
    env.DB.prepare(`
      INSERT OR IGNORE INTO message_recipient
        (message_id, mailbox_id, address, state, delivery_status, received_at)
      VALUES (?, ?, ?, 'unread', 'delivered', ?)
    `).bind(id, mailbox.id, `mailto:${message.to.toLowerCase()}`, now.toISOString()),
  ])
  if (reserved[0]?.meta.changes !== 1) return

  const storedKeys: string[] = []
  const attachmentStatements: D1PreparedStatement[] = []
  try {
    for (const [index, attachment] of parsed.attachments.entries()) {
      const attachmentId = `att_${await digest(`${id}\n${index}`, 32)}`
      const objectKey = `email/${id}/${attachmentId}`
      await env.ATTACHMENTS.put(objectKey, attachment.content, {
        httpMetadata: { contentType: attachment.mimeType },
        customMetadata: { messageId: id, attachmentId },
      })
      storedKeys.push(objectKey)
      attachmentStatements.push(env.DB.prepare(`
        INSERT INTO attachment
          (id, message_id, object_key, filename, media_type, disposition, content_id, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        attachmentId,
        id,
        objectKey,
        attachment.filename ?? null,
        attachment.mimeType || 'application/octet-stream',
        attachment.disposition ?? null,
        attachment.contentId ?? null,
        typeof attachment.content === 'string' ? new TextEncoder().encode(attachment.content).byteLength : attachment.content.byteLength,
        now.toISOString(),
      ))
    }
    if (attachmentStatements.length > 0) await env.DB.batch(attachmentStatements)
    console.log(JSON.stringify({ event: 'email_received', messageId: id, mailboxId: mailbox.id, attachmentCount: parsed.attachments.length }))
  } catch (error) {
    await Promise.all(storedKeys.map((key) => env.ATTACHMENTS.delete(key)))
    await env.DB.prepare('DELETE FROM message WHERE id = ?').bind(id).run()
    throw error
  }
}

export async function deleteExpiredEmail(env: Cloudflare.Env) {
  const expired = await env.DB.prepare(`
    SELECT id FROM message
    WHERE transport = 'email' AND expires_at <= ?
    ORDER BY expires_at
    LIMIT 100
  `).bind(new Date().toISOString()).all<{ id: string }>()
  const ids = expired.results.map((row) => row.id)
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  const attachments = await env.DB.prepare(`SELECT object_key FROM attachment WHERE message_id IN (${placeholders})`)
    .bind(...ids).all<{ object_key: string }>()
  await Promise.all(attachments.results.map((row) => env.ATTACHMENTS.delete(row.object_key)))
  await env.DB.batch(ids.map((id) => env.DB.prepare('DELETE FROM message WHERE id = ?').bind(id)))
  return ids.length
}

async function digest(value: ArrayBuffer | string, length = 64) {
  const buffer = typeof value === 'string' ? new TextEncoder().encode(value).slice().buffer : value
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length)
}
