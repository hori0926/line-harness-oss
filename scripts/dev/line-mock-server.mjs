#!/usr/bin/env node
/**
 * scripts/dev/line-mock-server.mjs
 *
 * LINE Messaging API のローカルモックサーバー。**開発専用**。
 *
 *   node scripts/dev/make-fixtures.mjs        # 先にテスト用メディアを生成
 *   node scripts/dev/line-mock-server.mjs     # 既定 http://127.0.0.1:8790
 *
 * worker 側は apps/worker/.dev.vars の
 *   LINE_API_BASE_URL=http://127.0.0.1:8790
 *   LINE_CONTENT_API_BASE_URL=http://127.0.0.1:8790
 * でここに向く。この 2 変数を本番で設定してはいけない理由は
 * apps/worker/src/middleware/line-api-base.ts の警告を参照。
 *
 * 実装しているエンドポイント:
 *   POST /v2/bot/message/push                    sentMessages[].quoteToken を返す。
 *                                                受信ボディを整形してコンソールへ出す
 *                                                (引用リプライの quoteToken 目視確認用)
 *   POST /v2/bot/message/reply                   同様にログして {} を返す
 *   GET  /v2/bot/profile/:userId                 プロフィール
 *   GET  /v2/bot/message/:messageId/content      メディア本体 (messageId で種別を出し分け)
 *   GET  /v2/bot/message/:messageId/content/preview  動画サムネイル (jpeg)
 *   POST /v2/bot/chat/loading/start              200 空
 *   その他 /v2/bot/*                              200 {} (想定外呼び出しで worker を落とさない)
 *
 * messageId → メディア種別の対応は「id に kind 名が含まれていればそれ」。
 * 例: mock-video-1725... → 動画 / mock-file-... → PDF。既定は画像。
 * scripts/dev/send-webhook.mjs が同じ規約で id を作る。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const DEFAULT_PORT = 8790;
const DEFAULT_HOST = '127.0.0.1';

/** messageId に含まれるキーワード → 配信するフィクスチャ。 */
const MEDIA = {
  video: { file: 'sample-video.mp4', contentType: 'video/mp4' },
  audio: { file: 'sample-audio.m4a', contentType: 'audio/mp4' },
  // LINE の Content API は file メッセージを application/octet-stream で返すことが多い。
  // worker 側 (services/incoming-media.ts) が元ファイル名の拡張子から
  // application/pdf を復元する経路をここで踏ませたいので、あえて octet-stream で返す。
  file: { file: '見積書.pdf', contentType: 'application/octet-stream' },
  image: { file: 'sample-image.jpg', contentType: 'image/jpeg' },
};
const PREVIEW = { file: 'sample-video-preview.jpg', contentType: 'image/jpeg' };

/** userId ごとの表示名。未知の userId は「テスト太郎」。 */
const PROFILES = {
  Umock0000000000000000000000000001: 'テスト太郎',
  Umock0000000000000000000000000002: '見積 花子',
  Umock0000000000000000000000000003: '動画 次郎',
};

function fixture(name) {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) {
    throw new Error(
      `fixture not found: ${path}\n先に \`node scripts/dev/make-fixtures.mjs\` を実行してください。`,
    );
  }
  return readFileSync(path);
}

function mediaKindFor(messageId) {
  const id = String(messageId).toLowerCase();
  for (const kind of ['video', 'audio', 'file', 'image']) {
    if (id.includes(kind)) return kind;
  }
  return 'image';
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.byteLength,
  });
  res.end(payload);
}

function binary(res, buffer, contentType) {
  // Content-Length を必ず明示する。worker 側 (services/incoming-media.ts) は
  // このヘッダを見てサイズ上限の事前判定をするので、モックでも本番同様に付ける。
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.byteLength,
  });
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function now() {
  return new Date().toISOString().slice(11, 23);
}

/** LINE の messageId 風 (19 桁前後の数値文字列)。 */
function numericId() {
  return String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
}

function newQuoteToken() {
  // 本物は base64url 風の不透明文字列。長さと文字種だけ寄せておく。
  return randomBytes(24).toString('base64url');
}

function logSendRequest(label, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    console.log(`\n[${now()}] ${label} (JSON としてパースできませんでした)\n${raw.toString('utf8')}`);
    return;
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`[${now()}] ${label}`);
  console.log(JSON.stringify(parsed, null, 2));

  // 引用リプライの確認用。messages[].quoteToken が乗っているかを一目で分かるようにする。
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const quoted = messages.filter((m) => m && typeof m.quoteToken === 'string' && m.quoteToken);
  if (quoted.length > 0) {
    console.log(`  ✅ 引用リプライ: quoteToken=${quoted.map((m) => m.quoteToken).join(', ')}`);
  } else if (messages.length > 0) {
    console.log('  ・quoteToken なし (通常送信)');
  }
  console.log('─'.repeat(72));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? DEFAULT_HOST}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  try {
    // ── モック自身の補助エンドポイント (LINE には無い) ──────────────────
    if (path === '/__mock/health') {
      return json(res, 200, { ok: true, fixtures: FIXTURES });
    }
    // 友だちアイコン。LINE の pictureUrl の代わりに自分で配る
    // (管理画面のアバターが壊れて見えるのを避けるため)。
    if (path.startsWith('/__mock/avatar/')) {
      return binary(res, fixture(MEDIA.image.file), 'image/jpeg');
    }

    // ── Content API ───────────────────────────────────────────────────
    const preview = path.match(/^\/v2\/bot\/message\/([^/]+)\/content\/preview$/);
    if (preview && method === 'GET') {
      console.log(`[${now()}] GET content/preview messageId=${preview[1]}`);
      return binary(res, fixture(PREVIEW.file), PREVIEW.contentType);
    }

    const content = path.match(/^\/v2\/bot\/message\/([^/]+)\/content$/);
    if (content && method === 'GET') {
      const messageId = decodeURIComponent(content[1]);
      const kind = mediaKindFor(messageId);
      const spec = MEDIA[kind];
      const buffer = fixture(spec.file);
      console.log(
        `[${now()}] GET content messageId=${messageId} kind=${kind} ` +
          `file=${spec.file} type=${spec.contentType} bytes=${buffer.byteLength}`,
      );
      return binary(res, buffer, spec.contentType);
    }

    // ── Messaging API ─────────────────────────────────────────────────
    if (path === '/v2/bot/message/push' && method === 'POST') {
      logSendRequest('POST /v2/bot/message/push', await readBody(req));
      return json(res, 200, {
        sentMessages: [{ id: numericId(), quoteToken: newQuoteToken() }],
      });
    }

    if (path === '/v2/bot/message/reply' && method === 'POST') {
      logSendRequest('POST /v2/bot/message/reply', await readBody(req));
      return json(res, 200, {
        sentMessages: [{ id: numericId(), quoteToken: newQuoteToken() }],
      });
    }

    if ((path === '/v2/bot/message/multicast' || path === '/v2/bot/message/broadcast') && method === 'POST') {
      logSendRequest(`POST ${path}`, await readBody(req));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Line-Request-Id': `mock-${numericId()}`,
        'Content-Length': 2,
      });
      return res.end('{}');
    }

    const profile = path.match(/^\/v2\/bot\/profile\/([^/]+)$/);
    if (profile && method === 'GET') {
      const userId = decodeURIComponent(profile[1]);
      const displayName = PROFILES[userId] ?? 'テスト太郎';
      console.log(`[${now()}] GET profile userId=${userId} → ${displayName}`);
      return json(res, 200, {
        displayName,
        userId,
        pictureUrl: `http://${DEFAULT_HOST}:${port}/__mock/avatar/${encodeURIComponent(userId)}.jpg`,
        statusMessage: 'L Harness ローカル開発用のモックプロフィールです',
      });
    }

    if (path === '/v2/bot/chat/loading/start' && method === 'POST') {
      await readBody(req);
      console.log(`[${now()}] POST chat/loading/start`);
      res.writeHead(200, { 'Content-Length': 0 });
      return res.end();
    }

    // ── それ以外の /v2/bot/* は 200 {} ─────────────────────────────────
    if (path.startsWith('/v2/bot/')) {
      if (method !== 'GET' && method !== 'DELETE') await readBody(req);
      console.log(`[${now()}] ${method} ${path} → 200 {} (未実装フォールバック)`);
      return json(res, 200, {});
    }

    console.log(`[${now()}] ${method} ${path} → 404`);
    return json(res, 404, { message: 'mock: not found' });
  } catch (err) {
    console.error(`[${now()}] ${method} ${path} → 500`, err);
    return json(res, 500, { message: String(err && err.message ? err.message : err) });
  }
});

function parsePort() {
  const flagIndex = process.argv.indexOf('--port');
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) return Number(process.argv[flagIndex + 1]);
  if (process.env.LINE_MOCK_PORT) return Number(process.env.LINE_MOCK_PORT);
  return DEFAULT_PORT;
}

const port = parsePort();

server.listen(port, DEFAULT_HOST, () => {
  console.log(`LINE Messaging API モック : http://${DEFAULT_HOST}:${port}`);
  console.log(`フィクスチャ              : ${FIXTURES}`);
  if (!existsSync(join(FIXTURES, MEDIA.video.file))) {
    console.log('⚠️  フィクスチャが未生成です。`node scripts/dev/make-fixtures.mjs` を先に実行してください。');
  }
  console.log('worker 側 .dev.vars に以下を設定してください (ローカル専用):');
  console.log(`  LINE_API_BASE_URL=http://${DEFAULT_HOST}:${port}`);
  console.log(`  LINE_CONTENT_API_BASE_URL=http://${DEFAULT_HOST}:${port}`);
  console.log('');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`ポート ${port} は使用中です。--port <番号> で変更してください。`);
    process.exit(1);
  }
  throw err;
});
