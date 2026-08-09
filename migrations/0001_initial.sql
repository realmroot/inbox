PRAGMA foreign_keys = ON;

CREATE TABLE mailbox (
  id TEXT PRIMARY KEY,
  agent_issuer TEXT NOT NULL,
  agent_subject TEXT NOT NULL,
  stable_address TEXT NOT NULL UNIQUE,
  alias_address TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_issuer, agent_subject)
);

CREATE TABLE retired_alias (
  address TEXT PRIMARY KEY,
  retired_at TEXT NOT NULL
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  sender_mailbox_id TEXT REFERENCES mailbox(id),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('agent', 'email')),
  sender_address TEXT NOT NULL,
  subject TEXT,
  text_content TEXT,
  html_content TEXT,
  in_reply_to TEXT REFERENCES message(id),
  transport TEXT NOT NULL CHECK (transport IN ('agent', 'email')),
  transport_reference TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX message_transport_reference_idx
  ON message(transport, transport_reference)
  WHERE transport_reference IS NOT NULL;
CREATE INDEX message_sender_created_idx
  ON message(sender_mailbox_id, created_at DESC, id DESC);

CREATE TABLE message_recipient (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('unread', 'read', 'archived')) DEFAULT 'unread',
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  version INTEGER NOT NULL DEFAULT 1,
  received_at TEXT,
  PRIMARY KEY (message_id, mailbox_id)
);

CREATE INDEX message_recipient_mailbox_created_idx
  ON message_recipient(mailbox_id, received_at DESC, message_id DESC);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT,
  media_type TEXT NOT NULL,
  disposition TEXT,
  content_id TEXT,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX attachment_message_idx ON attachment(message_id);

CREATE TABLE idempotency_record (
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, key)
);

CREATE TABLE dpop_replay (
  issuer TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (issuer, jti)
);
