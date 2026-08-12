ALTER TABLE mailbox ADD COLUMN agent_username TEXT;
CREATE UNIQUE INDEX mailbox_agent_username_unique
  ON mailbox(agent_username)
  WHERE agent_username IS NOT NULL;
