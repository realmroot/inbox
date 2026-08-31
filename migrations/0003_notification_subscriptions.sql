ALTER TABLE message ADD COLUMN routing_key TEXT;
ALTER TABLE message ADD COLUMN accepted_at TEXT;

UPDATE message SET accepted_at = created_at WHERE accepted_at IS NULL;

CREATE TABLE subscription (
  id TEXT PRIMARY KEY,
  owner_issuer TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  owner_client_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  event_types TEXT NOT NULL,
  delivery_url TEXT NOT NULL,
  authorization_scheme TEXT NOT NULL CHECK (authorization_scheme = 'bearer'),
  secret_ciphertext TEXT NOT NULL,
  secret_nonce TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX subscription_owner_created_idx
  ON subscription(owner_issuer, owner_subject, owner_client_id, created_at DESC, id DESC);
CREATE INDEX subscription_mailbox_idx ON subscription(mailbox_id);

CREATE TABLE notification_event (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type = 'message.created'),
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  routing_key TEXT,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  last_http_status INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (subscription_id, type, message_id)
);

CREATE INDEX notification_event_due_idx
  ON notification_event(status, next_attempt_at, lease_expires_at);
