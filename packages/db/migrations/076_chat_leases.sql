-- Separate from operator assignment: short-lived, authenticated editing ownership.
CREATE TABLE IF NOT EXISTS chat_leases (
  friend_id TEXT PRIMARY KEY REFERENCES friends(id),
  staff_id TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at);
