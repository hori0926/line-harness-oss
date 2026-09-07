ALTER TABLE messages_log ADD COLUMN content_updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_friend_content_updated ON messages_log(friend_id, content_updated_at);
