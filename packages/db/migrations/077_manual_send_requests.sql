CREATE TABLE IF NOT EXISTS manual_send_requests (
  request_id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  staff_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
