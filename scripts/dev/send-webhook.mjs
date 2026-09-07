#!/usr/bin/env node
/**
 * scripts/dev/send-webhook.mjs
 *
 * ローカルの worker に LINE webhook を実際に投げてテストデータを作る。**開発専用**。
 *
 *   node scripts/dev/line-mock-server.mjs      # 別ターミナルで起動しておく
 *   pnpm --filter worker exec vite dev --port 8787
 *   node scripts/dev/send-webhook.mjs
 *
 * 何をするか:
 *   1. 友だち 3 人分の follow イベント
 *      → worker がモックの GET /v2/bot/profile/:userId を叩いて friends を作る
 *   2. 各友だちにメッセージイベント (text / image / video / audio / file)
 *      → text には quoteToken を載せる (管理画面の引用リプライの引用元になる)
 *      → メディアはモックの Content API から取得され R2 に保存される
 *   3. 管理画面 API 経由でオペレーター返信を 2 通 (通常 + 引用リプライ)
 *      → messages_log.sent_by_staff_name が入り「送信者名」が確認できる
 *      → モックサーバーのコンソールに push ボディ (quoteToken 付き) が出る
 *
 * 署名は本物と同じく HMAC-SHA256(channel secret, 生ボディ) の base64。
 * secret は既定で apps/worker/.dev.vars の LINE_CHANNEL_SECRET を読む。
 *
 * オプション:
 *   --worker <url>    既定 http://localhost:8787
 *   --secret <値>     既定 .dev.vars の LINE_CHANNEL_SECRET
 *   --api-key <値>    既定 lh_devowner000000000000000000000001 (apply-local-db.sh が作る owner)
 *   --no-reply        オペレーター返信の投入をスキップ
 */
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DEV_VARS = join(ROOT, 'apps', 'worker', '.dev.vars');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function devVar(key) {
  if (!existsSync(DEV_VARS)) return undefined;
  for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const WORKER = arg('--worker', 'http://localhost:8787').replace(/\/$/, '');
const SECRET = arg('--secret', devVar('LINE_CHANNEL_SECRET'));
const API_KEY = arg('--api-key', 'lh_devowner000000000000000000000001');
const WITH_REPLY = !process.argv.includes('--no-reply');

if (!SECRET) {
  console.error('LINE_CHANNEL_SECRET が取れません。--secret <値> を渡すか apps/worker/.dev.vars を用意してください。');
  process.exit(1);
}

const FRIENDS = [
  { userId: 'Umock0000000000000000000000000001', label: 'テスト太郎' },
  { userId: 'Umock0000000000000000000000000002', label: '見積 花子' },
  { userId: 'Umock0000000000000000000000000003', label: '動画 次郎' },
];

let seq = 0;
/**
 * messageId は「種別名を含める」規約。モックサーバー
 * (scripts/dev/line-mock-server.mjs の mediaKindFor) がこの文字列を見て
 * 動画 / 音声 / PDF / 画像 を出し分ける。
 */
function messageId(kind) {
  seq += 1;
  return `mock-${kind}-${Date.now()}-${seq}`;
}

function quoteToken() {
  seq += 1;
  return `mockQuoteToken${Date.now()}${seq}`;
}

function sign(rawBody) {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('base64');
}

async function postWebhook(events, note) {
  // 署名は「送信する生バイト列」に対して計算する。JSON.stringify を 2 回呼んで
  // 別々の文字列を署名/送信すると検証に落ちるので、必ず同じ文字列を使う。
  const rawBody = JSON.stringify({ destination: 'Udevmockdestination', events });
  const res = await fetch(`${WORKER}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': sign(rawBody),
    },
    body: rawBody,
  });
  const text = await res.text();
  console.log(`  ${res.status} ${note} — ${text}`);
  if (!res.ok) throw new Error(`webhook failed: ${res.status}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseEvent(userId, type) {
  return {
    type,
    mode: 'active',
    timestamp: Date.now(),
    // replyToken は自動応答が使う。モック側は reply も 200 を返すので値は任意。
    replyToken: `mockReplyToken${Math.random().toString(36).slice(2, 12)}`,
    source: { type: 'user', userId },
    webhookEventId: `mockEvent${Math.random().toString(36).slice(2, 12)}`,
    deliveryContext: { isRedelivery: false },
  };
}

function textEvent(userId, text) {
  return {
    ...baseEvent(userId, 'message'),
    message: { id: messageId('text'), type: 'text', text, quoteToken: quoteToken() },
  };
}

function mediaEvent(userId, kind, extra = {}) {
  return {
    ...baseEvent(userId, 'message'),
    message: {
      id: messageId(kind),
      type: kind,
      contentProvider: { type: 'line' },
      quoteToken: quoteToken(),
      ...extra,
    },
  };
}

async function adminFetch(path, init = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function main() {
  console.log(`worker : ${WORKER}`);
  console.log(`secret : ${SECRET.slice(0, 4)}… (.dev.vars の LINE_CHANNEL_SECRET)`);
  console.log('');

  console.log('1) follow イベント (友だち作成 + プロフィール取得)');
  for (const f of FRIENDS) {
    await postWebhook([baseEvent(f.userId, 'follow')], `follow ${f.label}`);
    // follow ハンドラは ref_code の解決で最大 1 秒待つので、その分を見込む。
    await sleep(1800);
  }

  console.log('');
  console.log('2) メッセージイベント');

  // テスト太郎: テキスト (引用元) + 画像
  await postWebhook(
    [textEvent(FRIENDS[0].userId, 'こんにちは。先日の件、進捗はいかがでしょうか？')],
    'text テスト太郎',
  );
  await sleep(800);
  await postWebhook([mediaEvent(FRIENDS[0].userId, 'image')], 'image テスト太郎');
  await sleep(1500);

  // 見積 花子: テキスト + PDF (日本語ファイル名) + 音声
  await postWebhook(
    [textEvent(FRIENDS[1].userId, '見積書をお送りします。ご確認ください。')],
    'text 見積花子',
  );
  await sleep(800);
  await postWebhook(
    [mediaEvent(FRIENDS[1].userId, 'file', { fileName: '見積書.pdf', fileSize: 936 })],
    'file 見積花子 (見積書.pdf)',
  );
  await sleep(1500);
  await postWebhook(
    [mediaEvent(FRIENDS[1].userId, 'audio', { duration: 4000 })],
    'audio 見積花子',
  );
  await sleep(1500);

  // 動画 次郎: テキスト + 動画
  await postWebhook(
    [textEvent(FRIENDS[2].userId, '現場の様子を撮ったので送ります。')],
    'text 動画次郎',
  );
  await sleep(800);
  await postWebhook([mediaEvent(FRIENDS[2].userId, 'video', { duration: 4000 })], 'video 動画次郎');
  await sleep(2500);

  if (!WITH_REPLY) {
    console.log('\n--no-reply 指定のためオペレーター返信はスキップしました。');
    return;
  }

  console.log('');
  console.log('3) 管理画面 API 経由のオペレーター返信 (送信者名 + 引用リプライ)');

  const friendRow = await adminFetch(
    `/api/friends?limit=100`,
  ).then((rows) => (Array.isArray(rows) ? rows : rows?.items ?? []))
   .then((rows) => rows.find((r) => (r.lineUserId ?? r.line_user_id) === FRIENDS[0].userId));

  if (!friendRow) {
    console.log('  友だちが見つかりませんでした (返信はスキップ)');
    return;
  }

  const chatId = friendRow.id;
  const detail = await adminFetch(`/api/chats/${chatId}`);
  const quotable = [...detail.messages]
    .reverse()
    .find((m) => m.direction === 'incoming' && m.messageType === 'text' && m.quotable);

  await adminFetch(`/api/chats/${chatId}/send`, {
    method: 'POST',
    body: JSON.stringify({ content: 'お問い合わせありがとうございます。担当より折り返します。' }),
  });
  console.log('  通常返信を送信しました');

  if (quotable) {
    await adminFetch(`/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'こちらの件、今週中に回答いたします。',
        quotedMessageId: quotable.id,
      }),
    });
    console.log(`  引用リプライを送信しました (引用元 messageId=${quotable.id})`);
    console.log('  → モックサーバーのコンソールに quoteToken 付きの push ボディが出ています');
  } else {
    console.log('  引用可能な受信メッセージが見つかりませんでした');
  }

  console.log('');
  console.log(`チャット画面: ${WORKER.replace(':8787', ':3001')}/chats?friend=${chatId}`);
}

main().catch((err) => {
  console.error('\n失敗:', err.message);
  process.exit(1);
});
