CREATE TABLE service_message_sender (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL
);

CREATE INDEX service_message_sender_client_idx
  ON service_message_sender(client_id, message_id);

CREATE TABLE service_idempotency_record (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
);
