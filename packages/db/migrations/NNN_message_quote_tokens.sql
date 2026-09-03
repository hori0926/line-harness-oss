-- Migration NNN: 管理画面 1:1 チャットの「引用リプライ」対応
--
-- LINE Messaging API の quoteToken を messages_log に保存し、後からオペレーター
-- が任意の受信メッセージを引用して返信できるようにする。
--
-- quote_token:
--   受信 webhook のメッセージオブジェクト (text / sticker / image / video) に
--   含まれる quoteToken。有効期限が無いので受信時に保存しておけばいつでも
--   引用できる。quoteToken を持たないイベント (postback / 送信ログ / 引用に
--   対応しないメッセージ種別) では NULL。
-- quoted_message_id:
--   この送信メッセージがどの messages_log 行を引用したか。管理画面が同じ
--   messages 配列から引用元を引いてプレビューを描画するために使う。引用なしの
--   送信・受信メッセージでは NULL。
--
-- 既存 DB への影響:
--   additive-only (ADD COLUMN のみ)。既存行は両列とも NULL になり、引用でき
--   ない (= 従来どおりの) メッセージとして扱われる。この migration 適用前に
--   受信済みのメッセージには quoteToken が残っていないため遡って引用する術は
--   無く、それが NULL 許容にしている理由でもある (NOT NULL + DEFAULT では
--   「引用不可」と「引用トークン未取得」を区別できない)。

ALTER TABLE messages_log ADD COLUMN quote_token TEXT;
ALTER TABLE messages_log ADD COLUMN quoted_message_id TEXT;
