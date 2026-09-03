import { applyD1Migrations, env, reset } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('preserves existing Inbox data when additive service Message sender storage is applied', async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 3))
  const now = '2026-08-31T00:00:00.000Z'
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO mailbox
      (id, agent_issuer, agent_subject, stable_address, agent_username, version, created_at, updated_at)
      VALUES ('mailbox-a', 'https://id.test/api/auth', '019feeeb-6504-74ec-bfdc-da5259f73fc0', 'alpha@agents.test', 'alpha', 1, ?, ?)`)
      .bind(now, now),
    env.DB.prepare(`INSERT INTO mailbox
      (id, agent_issuer, agent_subject, stable_address, agent_username, version, created_at, updated_at)
      VALUES ('mailbox-b', 'https://id.test/api/auth', '019feeeb-6504-74ec-bfdc-da5259f73fc1', 'beta@agents.test', 'beta', 1, ?, ?)`)
      .bind(now, now),
    env.DB.prepare(`INSERT INTO message
      (id, sender_mailbox_id, sender_kind, sender_address, subject, text_content, transport, routing_key, accepted_at, created_at)
      VALUES ('msg_11111111111111111111111111111111', 'mailbox-a', 'agent', 'agent:019feeeb-6504-74ec-bfdc-da5259f73fc0',
        'Preserved', 'Body', 'agent', 'routing-a', ?, ?)`)
      .bind(now, now),
    env.DB.prepare(`INSERT INTO message_recipient
      (message_id, mailbox_id, address, state, delivery_status, version, received_at)
      VALUES ('msg_11111111111111111111111111111111', 'mailbox-b', 'agent:019feeeb-6504-74ec-bfdc-da5259f73fc1', 'unread', 'delivered', 1, ?)`)
      .bind(now),
    env.DB.prepare(`INSERT INTO idempotency_record
      (mailbox_id, key, request_hash, message_id, created_at)
      VALUES ('mailbox-a', 'preserved-key', 'preserved-hash', 'msg_11111111111111111111111111111111', ?)`)
      .bind(now),
    env.DB.prepare(`INSERT INTO subscription
      (id, owner_issuer, owner_subject, owner_client_id, mailbox_id, event_types, delivery_url, authorization_scheme,
       secret_ciphertext, secret_nonce, version, created_at, updated_at)
      VALUES ('sub_11111111111111111111111111111111', 'https://id.test/api/auth', 'agency-service', 'realmroot-agency',
        'mailbox-b', '["message.created"]', 'https://agency.test/events', 'bearer', 'ciphertext', 'nonce', 1, ?, ?)`)
      .bind(now, now),
    env.DB.prepare(`INSERT INTO notification_event
      (id, subscription_id, type, agent_id, message_id, routing_key, occurred_at, status, attempt_count, next_attempt_at, created_at, updated_at)
      VALUES ('event-a', 'sub_11111111111111111111111111111111', 'message.created', '019feeeb-6504-74ec-bfdc-da5259f73fc1',
        'msg_11111111111111111111111111111111', 'routing-a', ?, 'pending', 0, ?, ?, ?)`)
      .bind(now, now, now, now),
  ])

  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(3, 4))

  await expect(env.DB.prepare("SELECT subject, text_content, routing_key, accepted_at FROM message WHERE id = 'msg_11111111111111111111111111111111'").first())
    .resolves.toEqual({ subject: 'Preserved', text_content: 'Body', routing_key: 'routing-a', accepted_at: now })
  await expect(env.DB.prepare("SELECT address, state, delivery_status FROM message_recipient WHERE message_id = 'msg_11111111111111111111111111111111'").first())
    .resolves.toEqual({ address: 'agent:019feeeb-6504-74ec-bfdc-da5259f73fc1', state: 'unread', delivery_status: 'delivered' })
  await expect(env.DB.prepare("SELECT request_hash, message_id FROM idempotency_record WHERE key = 'preserved-key'").first())
    .resolves.toEqual({ request_hash: 'preserved-hash', message_id: 'msg_11111111111111111111111111111111' })
  await expect(env.DB.prepare("SELECT status, routing_key FROM notification_event WHERE id = 'event-a'").first())
    .resolves.toEqual({ status: 'pending', routing_key: 'routing-a' })
  await expect(env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('service_message_sender', 'service_idempotency_record') ORDER BY name").all())
    .resolves.toMatchObject({ results: [{ name: 'service_idempotency_record' }, { name: 'service_message_sender' }] })
  await expect(env.DB.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] })
})
