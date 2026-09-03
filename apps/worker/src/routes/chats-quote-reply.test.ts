import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// 引用リプライ (quotedMessageId) のテスト。DB は fake、LINE API は fetch を
// 差し替えて「実際に LINE へ送られるペイロード」を検証する。
vi.mock('@line-crm/db', () => ({
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  resolveDefaultAccessToken: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-09-03T12:00:00.000+09:00'),
}));

import {
  getChatById,
  getFriendById,
  resolveDefaultAccessToken,
  updateChat,
} from '@line-crm/db';
import { chats } from './chats.js';

type Query = { sql: string; params: unknown[] };
type LogRow = {
  id: string;
  friend_id: string;
  quote_token: string | null;
  quoted_message_id?: string | null;
};

const CHAT = {
  id: 'chat-1',
  friend_id: 'friend-1',
  operator_id: null,
  status: 'in_progress',
  notes: null,
  last_message_at: '2026-09-03T11:00:00.000+09:00',
  created_at: '2026-09-03T10:00:00.000+09:00',
  updated_at: '2026-09-03T11:00:00.000+09:00',
};

const FRIEND = {
  id: 'friend-1',
  line_user_id: `U${'1'.repeat(32)}`,
  display_name: 'Quoter',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: null,
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-09-03T10:00:00.000+09:00',
  updated_at: '2026-09-03T10:00:00.000+09:00',
};

/**
 * messages_log を最低限だけ模した fake D1。
 * - SELECT quote_token ... WHERE id = ? AND friend_id = ? を実際に絞り込むので、
 *   越境 (別の友だちの message id) が本当に弾かれるかを検証できる。
 * - 送信ログの INSERT も rows に反映するので、「送ったメッセージを次の送信で
 *   引用する」という2ステップのシナリオをそのまま書ける。
 */
function fakeDb(seed: LogRow[] = []) {
  const queries: Query[] = [];
  const rows: LogRow[] = [...seed];
  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          queries.push({ sql, params: statement.params });
          if (sql.includes('INSERT INTO messages_log')) {
            // 送信ログの bind 順:
            // (id, friend_id, message_type, content, quote_token, quoted_message_id, created_at)
            const [id, friendId, , , quoteToken, quotedMessageId] = statement.params as [
              string, string, string, string, string | null, string | null, string,
            ];
            rows.push({
              id,
              friend_id: friendId,
              quote_token: quoteToken,
              quoted_message_id: quotedMessageId,
            });
          }
          return {};
        },
        async all() {
          queries.push({ sql, params: statement.params });
          if (sql.includes('FROM messages_log')) {
            return {
              results: rows.map((r) => ({
                ...r,
                direction: 'incoming',
                message_type: 'text',
                content: 'hi',
                created_at: '2026-09-03T11:00:00.000+09:00',
                quoted_message_id: r.quoted_message_id ?? null,
              })),
            };
          }
          return { results: [] };
        },
        async first() {
          queries.push({ sql, params: statement.params });
          if (sql.includes('SELECT quote_token FROM messages_log')) {
            const [id, friendId] = statement.params as [string, string];
            return rows.find((r) => r.id === id && r.friend_id === friendId) ?? null;
          }
          if (sql.includes('FROM friends')) {
            return {
              display_name: FRIEND.display_name,
              picture_url: null,
              line_user_id: FRIEND.line_user_id,
            };
          }
          return null;
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, queries, rows };
}

const ENV = { LINE_CHANNEL_ACCESS_TOKEN: 'env-token' } as Record<string, unknown>;

function app() {
  const instance = new Hono();
  instance.route('/', chats);
  return instance;
}

function send(db: D1Database, body: Record<string, unknown>) {
  return app().request(
    new Request('http://worker.test/api/chats/friend-1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {},
    { ...ENV, DB: db } as never,
  );
}

function pushPayloads(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls
    .filter(([url]) => String(url).includes('/v2/bot/message/push'))
    .map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)) as {
        to: string;
        messages: Array<Record<string, unknown>>;
      },
    );
}

function lastPushPayload(mock: ReturnType<typeof vi.fn>) {
  const all = pushPayloads(mock);
  return all.length > 0 ? all[all.length - 1] : null;
}

function outgoingInsert(queries: Query[]) {
  return queries.find((q) => q.sql.includes('INSERT INTO messages_log'));
}

/** LINE の push レスポンス (成功時は sentMessages が返る) */
function pushResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChatById).mockResolvedValue(CHAT as never);
  vi.mocked(getFriendById).mockResolvedValue(FRIEND as never);
  vi.mocked(resolveDefaultAccessToken).mockResolvedValue('account-token');
  vi.mocked(updateChat).mockResolvedValue(CHAT as never);
  // Response の body は1回しか読めないので、呼び出しごとに新しい Response を返す
  fetchMock = vi.fn(() =>
    Promise.resolve(
      pushResponse({ sentMessages: [{ id: '461230966842064897', quoteToken: 'sent-token-1' }] }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('POST /api/chats/:id/send — 引用リプライ', () => {
  test('quotedMessageId 指定時、LINE へのペイロードに quoteToken が含まれる', async () => {
    const { db, queries } = fakeDb([
      { id: 'msg-1', friend_id: 'friend-1', quote_token: 'token-abc' },
    ]);

    const res = await send(db, { messageType: 'text', content: '了解です', quotedMessageId: 'msg-1' });

    expect(res.status).toBe(200);
    expect(lastPushPayload(fetchMock)?.messages[0]).toEqual({
      type: 'text',
      text: '了解です',
      quoteToken: 'token-abc',
    });

    // 送信ログに quoted_message_id が残ること
    const insert = outgoingInsert(queries);
    expect(insert?.sql).toContain('quoted_message_id');
    expect(insert?.params).toContain('msg-1');
  });

  test('別の友だちのメッセージIDを指定すると 400 (越境防止)', async () => {
    // quote_token を持つが friend_id が別人の行
    const { db, queries } = fakeDb([
      { id: 'other-msg', friend_id: 'friend-999', quote_token: 'token-secret' },
    ]);

    const res = await send(db, { messageType: 'text', content: 'のぞき見', quotedMessageId: 'other-msg' });

    expect(res.status).toBe(400);
    // LINE へ送信していないこと (他人の quoteToken が漏れない)
    expect(lastPushPayload(fetchMock)).toBeNull();
    // 引用元クエリが friend_id で絞り込んでいること
    const lookup = queries.find((q) => q.sql.includes('SELECT quote_token FROM messages_log'));
    expect(lookup?.sql).toContain('friend_id = ?');
    expect(lookup?.params).toEqual(['other-msg', 'friend-1']);
  });

  test('quote_token が NULL の行を指定すると 400', async () => {
    const { db } = fakeDb([{ id: 'msg-2', friend_id: 'friend-1', quote_token: null }]);

    const res = await send(db, { messageType: 'text', content: 'だめ', quotedMessageId: 'msg-2' });

    expect(res.status).toBe(400);
    expect(lastPushPayload(fetchMock)).toBeNull();
  });

  test('messageType: image で quotedMessageId を指定すると 400', async () => {
    const { db } = fakeDb([{ id: 'msg-1', friend_id: 'friend-1', quote_token: 'token-abc' }]);

    const res = await send(db, {
      messageType: 'image',
      content: JSON.stringify({ originalContentUrl: 'https://x/i.jpg', previewImageUrl: 'https://x/p.jpg' }),
      quotedMessageId: 'msg-1',
    });

    expect(res.status).toBe(400);
    expect(lastPushPayload(fetchMock)).toBeNull();
  });

  test('quotedMessageId 未指定なら従来どおり送信できる (回帰防止)', async () => {
    const { db, queries } = fakeDb([{ id: 'msg-1', friend_id: 'friend-1', quote_token: 'token-abc' }]);

    const res = await send(db, { messageType: 'text', content: 'ふつうの返信' });

    expect(res.status).toBe(200);
    // quoteToken キー自体が付かないこと
    expect(lastPushPayload(fetchMock)?.messages[0]).toEqual({ type: 'text', text: 'ふつうの返信' });
    // 引用元の検索も走らないこと
    expect(queries.some((q) => q.sql.includes('SELECT quote_token FROM messages_log'))).toBe(false);
    // quoted_message_id は NULL
    expect(outgoingInsert(queries)?.params).toContain(null);
  });
});

describe('POST /api/chats/:id/send — 送信メッセージ自身の quoteToken 保存', () => {
  test('push レスポンスの quoteToken を outgoing 行の quote_token に保存する', async () => {
    const { db, queries, rows } = fakeDb();

    const res = await send(db, { messageType: 'text', content: '案内を送ります' });

    expect(res.status).toBe(200);
    const insert = outgoingInsert(queries);
    expect(insert?.sql).toContain('quote_token');
    expect(insert?.params).toContain('sent-token-1');
    expect(rows[0]).toMatchObject({ friend_id: 'friend-1', quote_token: 'sent-token-1' });
  });

  test('image / flex 送信でも quoteToken を保存する', async () => {
    for (const body of [
      {
        messageType: 'image',
        content: JSON.stringify({ originalContentUrl: 'https://x/i.jpg', previewImageUrl: 'https://x/p.jpg' }),
      },
      { messageType: 'flex', content: JSON.stringify({ type: 'bubble' }) },
    ]) {
      const { db, queries } = fakeDb();
      const res = await send(db, body);
      expect(res.status).toBe(200);
      expect(outgoingInsert(queries)?.params).toContain('sent-token-1');
    }
  });

  test('sentMessages が無い / 形式違いのレスポンスでも 200 のまま quote_token は NULL', async () => {
    for (const payload of [{}, { sentMessages: [] }, { sentMessages: [{ id: '1' }] }, { sentMessages: 'broken' }]) {
      fetchMock.mockImplementation(() => Promise.resolve(pushResponse(payload)));
      const { db, queries, rows } = fakeDb();

      const res = await send(db, { messageType: 'text', content: '送れてはいる' });

      // 送信自体は成功しているので、ここで失敗させない (再送=二重送信の防止)
      expect(res.status).toBe(200);
      expect((await res.json() as { data: { sent: boolean } }).data.sent).toBe(true);
      expect(outgoingInsert(queries)?.params).toContain(null);
      expect(rows[0]?.quote_token).toBeNull();
    }
  });

  test('保存した outgoing 行を引用元にして送信できる (自分の送信も引用可能)', async () => {
    const { db, rows } = fakeDb();

    // 1通目: オペレーターが送信 → quote_token が保存される
    const first = await send(db, { messageType: 'text', content: '先ほどのご案内です' });
    expect(first.status).toBe(200);
    const sentRow = rows[0];
    expect(sentRow.quote_token).toBe('sent-token-1');

    // 2通目: 1通目 (outgoing) を引用して送信
    const second = await send(db, {
      messageType: 'text',
      content: 'こちらの件です',
      quotedMessageId: sentRow.id,
    });

    expect(second.status).toBe(200);
    expect(lastPushPayload(fetchMock)?.messages[0]).toEqual({
      type: 'text',
      text: 'こちらの件です',
      quoteToken: 'sent-token-1',
    });
  });
});

describe('GET /api/chats/:id — quotable / quotedMessageId', () => {
  test('messages の各要素に quotable と quotedMessageId が含まれ、トークン実値は返さない', async () => {
    const { db, queries } = fakeDb([
      { id: 'msg-1', friend_id: 'friend-1', quote_token: 'token-abc', quoted_message_id: null },
      { id: 'msg-2', friend_id: 'friend-1', quote_token: null, quoted_message_id: 'msg-1' },
    ]);

    const res = await app().request(
      new Request('http://worker.test/api/chats/friend-1'),
      {},
      { ...ENV, DB: db } as never,
    );

    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      data: { messages: Array<{ id: string; quotable: boolean; quotedMessageId: string | null }> };
    };
    // ルートは新しい順に取って reverse するので、id で引いて検証する
    const byId = Object.fromEntries(body.data.messages.map((m) => [m.id, m]));
    expect(byId['msg-1']).toMatchObject({ quotable: true, quotedMessageId: null });
    expect(byId['msg-2']).toMatchObject({ quotable: false, quotedMessageId: 'msg-1' });

    // quoteToken の実値がレスポンスに一切現れないこと
    expect(raw).not.toContain('token-abc');
    expect(raw).not.toContain('quoteToken');

    const select = queries.find((q) => q.sql.includes('FROM messages_log') && q.sql.includes('SELECT id'));
    expect(select?.sql).toContain('quote_token');
    expect(select?.sql).toContain('quoted_message_id');
  });
});
