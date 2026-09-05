-- Migration 075: チャット差分ポーリング用の複合インデックス
--
-- GET /api/chats/:id?since=... は 15 秒ごとに、1 人の友だちについて
-- created_at の境界以降だけを読む。friend_id と created_at の単独 index では
-- 片方しか検索条件に使えず、履歴が増えるほど同じ会話の全行を読み直し得る。
-- id まで含めることで、同一ミリ秒に複数行があっても安定した順序で返せる。
-- 複合 index により、対象 friend の時刻範囲だけを読む。

CREATE INDEX IF NOT EXISTS idx_messages_log_friend_created
  ON messages_log (friend_id, created_at, id);
