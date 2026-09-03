import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// 複数スタッフ運用 (multi-operator) のテスト。
//  - 送信スタッフの記録 (messages_log.sent_by_staff_id / sent_by_staff_name)
//  - 差分取得 (GET /api/chats/:id?since=) — ポーリングの D1 読み取り行数対策
// DB は fake、LINE API は fetch を差し替える (chats-quote-reply.test.ts と同じ形)。
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
  // 実装と同じ JST 表記への正規化 (?since= のパースで使う)
  toJstString: (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, -1) + '+09:00',
}));

import {
  getChatById,
  getFriendById,
  resolveDefaultAccessToken,
  updateChat,
} from '@line-crm/db';
import { chats } from './chats.js';
import type { Env } from '../index.js';

type Query = { sql: string; params: unknown[] };
type LogRow = {
  id: string;
  friend_id: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  created_at: string;
  source?: string | null;
  quote_token?: string | null;
  quoted_message_id?: string | null;
  sent_by_staff_id?: string | null;
  sent_by_staff_name?: string | null;
};

const CHAT = {
  id: 'chat-1',
  friend_id: 'friend-1',
  operator_id: 'op-1',
  status: 'in_progress',
  notes: '前回は資料送付まで完了',
  last_message_at: '2026-09-03T11:00:00.000+09:00',
  created_at: '2026-09-03T10:00:00.000+09:00',
  updated_at: '2026-09-03T11:00:00.000+09:00',
};

const FRIEND = {
  id: 'friend-1',
  line_user_id: `U${'1'.repeat(32)}`,
  display_name: '山田太郎',
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

const STAFF = { id: 'staff-7', name: '佐藤花子', role: 'staff' as const };

/**
 * messages_log を最低限だけ模した fake D1。
 * - `created_at > ?` を **実際に評価する** ので、since の境界 (同時刻を含まない)
 *   をテストで固定できる。
 * - ORDER BY も見て並べ替えるので、差分モードが reverse していないことも検証できる。
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
            // 送信ログの bind 順: (id, friend_id, message_type, content,
            //   quote_token, quoted_message_id, sent_by_staff_id, sent_by_staff_name, created_at)
            const [id, friendId, , content, quoteToken, quotedMessageId, staffId, staffName, createdAt] =
              statement.params as [
                string, string, string, string,
                string | null, string | null, string | null, string | null, string,
              ];
            rows.push({
              id,
              friend_id: friendId,
              direction: 'outgoing',
              content,
              created_at: createdAt,
              source: 'manual',
              quote_token: quoteToken,
              quoted_message_id: quotedMessageId,
              sent_by_staff_id: staffId,
              sent_by_staff_name: staffName,
            });
          }
          return {};
        },
        async all() {
          queries.push({ sql, params: statement.params });
          if (sql.includes('FROM messages_log')) {
            const [friendId, since] = statement.params as [string, string | undefined];
            let results = rows.filter((r) => r.friend_id === friendId);
            // 実装と同じく文字列比較・排他 (>) で絞る
            if (sql.includes('created_at > ?') && since !== undefined) {
              results = results.filter((r) => r.created_at > since);
            }
            results = [...results].sort((a, b) =>
              sql.includes('ORDER BY created_at DESC')
                ? b.created_at.localeCompare(a.created_at)
                : a.created_at.localeCompare(b.created_at),
            );
            return {
              results: results.map((r) => ({
                id: r.id,
                friend_id: r.friend_id,
                direction: r.direction,
                message_type: 'text',
                content: r.content,
                quote_token: r.quote_token ?? null,
                quoted_message_id: r.quoted_message_id ?? null,
                sent_by_staff_name: r.sent_by_staff_name ?? null,
                created_at: r.created_at,
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

/**
 * `staff` を渡すと authMiddleware 相当 (c.set('staff', ...)) を挟む。
 * 渡さない場合は「スタッフが取れない経路」の再現になる。
 */
function app(staff?: typeof STAFF) {
  const instance = new Hono<Env>();
  if (staff) {
    instance.use('*', async (c, next) => {
      c.set('staff', staff);
      await next();
    });
  }
  instance.route('/', chats);
  return instance;
}

function send(db: D1Database, body: Record<string, unknown>, staff?: typeof STAFF) {
  return app(staff).request(
    new Request('http://worker.test/api/chats/friend-1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {},
    { ...ENV, DB: db } as never,
  );
}

function get(db: D1Database, query = '') {
  return app().request(
    new Request(`http://worker.test/api/chats/friend-1${query}`),
    {},
    { ...ENV, DB: db } as never,
  );
}

type ChatDetail = {
  status: string;
  notes: string | null;
  friendName: string;
  lastMessageAt: string | null;
  isDelta: boolean;
  messages: Array<{ id: string; createdAt: string; sentByStaffName: string | null }>;
};

async function getBody(res: Response): Promise<{ raw: string; data: ChatDetail }> {
  const raw = await res.text();
  return { raw, data: (JSON.parse(raw) as { data: ChatDetail }).data };
}

function outgoingInsert(queries: Query[]) {
  return queries.find((q) => q.sql.includes('INSERT INTO messages_log'));
}

function messagesSelect(queries: Query[]) {
  return queries.find((q) => q.sql.includes('FROM messages_log') && q.sql.includes('SELECT id'));
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

describe('POST /api/chats/:id/send — 送信スタッフの記録', () => {
  test('認証済みスタッフの id と名前を送信ログに保存する', async () => {
    const { db, queries, rows } = fakeDb();

    const res = await send(db, { messageType: 'text', content: '承知しました' }, STAFF);

    expect(res.status).toBe(200);
    const insert = outgoingInsert(queries);
    expect(insert?.sql).toContain('sent_by_staff_id');
    expect(insert?.sql).toContain('sent_by_staff_name');
    expect(rows[0]).toMatchObject({
      sent_by_staff_id: 'staff-7',
      sent_by_staff_name: '佐藤花子',
    });
  });

  test('スタッフが取れない経路でも 200 で送信でき、両方 NULL で保存される', async () => {
    const { db, rows } = fakeDb();

    // staff 未設定 = c.get('staff') が undefined の経路
    const res = await send(db, { messageType: 'text', content: '送信は壊さない' });

    // 記録が取れないことを理由に送信を失敗させてはいけない (再送 = 二重送信)
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { sent: boolean } }).data.sent).toBe(true);
    expect(rows[0].sent_by_staff_id).toBeNull();
    expect(rows[0].sent_by_staff_name).toBeNull();
  });
});

describe('GET /api/chats/:id — 差分取得 (?since=)', () => {
  const SEED: LogRow[] = [
    {
      id: 'msg-old',
      friend_id: 'friend-1',
      direction: 'incoming',
      content: '古い問い合わせ',
      created_at: '2026-09-03T10:00:00.000+09:00',
      source: 'user',
    },
    {
      id: 'msg-boundary',
      friend_id: 'friend-1',
      direction: 'outgoing',
      content: '境界ちょうどの返信',
      created_at: '2026-09-03T11:00:00.000+09:00',
      source: 'manual',
      sent_by_staff_name: '佐藤花子',
    },
    {
      id: 'msg-new',
      friend_id: 'friend-1',
      direction: 'incoming',
      content: '新着',
      created_at: '2026-09-03T11:30:00.000+09:00',
      source: 'user',
    },
  ];

  test('since より後の行だけを返す (同時刻の行は含まない = 排他比較)', async () => {
    const { db, queries } = fakeDb(SEED);

    const res = await get(db, '?since=2026-09-03T11:00:00.000%2B09:00');

    expect(res.status).toBe(200);
    const { data } = await getBody(res);
    expect(data.isDelta).toBe(true);
    // msg-boundary は since と完全に同時刻 → 含まれない
    expect(data.messages.map((m) => m.id)).toEqual(['msg-new']);

    const select = messagesSelect(queries);
    expect(select?.sql).toContain('created_at > ?');
    expect(select?.sql).toContain('ORDER BY created_at ASC');
    expect(select?.sql).toContain('LIMIT 200');
    expect(select?.params).toEqual(['friend-1', '2026-09-03T11:00:00.000+09:00']);
  });

  test('UTC (Z) 表記の since でも JST に正規化して比較する', async () => {
    const { db, queries } = fakeDb(SEED);

    // 2026-09-03T02:00:00Z == 2026-09-03T11:00:00+09:00 (境界ちょうど)
    const res = await get(db, '?since=2026-09-03T02:00:00.000Z');

    expect(res.status).toBe(200);
    const { data } = await getBody(res);
    expect(data.messages.map((m) => m.id)).toEqual(['msg-new']);
    expect(messagesSelect(queries)?.params).toEqual([
      'friend-1',
      '2026-09-03T11:00:00.000+09:00',
    ]);
  });

  test('since 指定でも status / notes などの会話メタ情報は完全な値を返す', async () => {
    const { db } = fakeDb(SEED);

    const res = await get(db, '?since=2026-09-03T11:00:00.000%2B09:00');

    const { data } = await getBody(res);
    expect(data).toMatchObject({
      status: 'in_progress',
      notes: '前回は資料送付まで完了',
      friendName: '山田太郎',
      lastMessageAt: '2026-09-03T11:00:00.000+09:00',
    });
  });

  test('since 未指定なら従来どおり全件を昇順で返す (回帰防止)', async () => {
    const { db, queries } = fakeDb(SEED);

    const res = await get(db);

    expect(res.status).toBe(200);
    const { data } = await getBody(res);
    expect(data.isDelta).toBe(false);
    expect(data.messages.map((m) => m.id)).toEqual(['msg-old', 'msg-boundary', 'msg-new']);

    const select = messagesSelect(queries);
    expect(select?.sql).not.toContain('created_at > ?');
    expect(select?.sql).toContain('ORDER BY created_at DESC LIMIT 1000');
    expect(select?.params).toEqual(['friend-1']);
  });

  test('パースできない since は 400 にせず全件へフォールバックする', async () => {
    for (const bad of ['not-a-date', 'yesterday', '%20']) {
      const { db, queries } = fakeDb(SEED);

      const res = await get(db, `?since=${bad}`);

      // ポーリングが壊れて画面が凍るより、多めに読むほうが安全
      expect(res.status).toBe(200);
      const { data } = await getBody(res);
      expect(data.isDelta).toBe(false);
      expect(data.messages).toHaveLength(3);
      expect(messagesSelect(queries)?.sql).not.toContain('created_at > ?');
    }
  });
});

describe('GET /api/chats/:id — sentByStaffName', () => {
  test('手動返信は送信者名を返し、sent_by_staff_id は返さない', async () => {
    const { db, queries } = fakeDb([
      {
        id: 'msg-manual',
        friend_id: 'friend-1',
        direction: 'outgoing',
        content: '担当より返信',
        created_at: '2026-09-03T11:00:00.000+09:00',
        source: 'manual',
        sent_by_staff_id: 'staff-7',
        sent_by_staff_name: '佐藤花子',
      },
    ]);

    const res = await get(db);

    expect(res.status).toBe(200);
    const { raw, data } = await getBody(res);
    expect(data.messages[0]).toMatchObject({ id: 'msg-manual', sentByStaffName: '佐藤花子' });
    // 内部 ID の実値もキー名もレスポンスに現れないこと
    expect(raw).not.toContain('staff-7');
    expect(raw).not.toContain('sentByStaffId');
    expect(raw).not.toContain('sent_by_staff_id');
    // SELECT でも id 列は引かない (露出経路を構造的に断つ)
    expect(messagesSelect(queries)?.sql).toContain('sent_by_staff_name');
    expect(messagesSelect(queries)?.sql).not.toContain('sent_by_staff_id');
  });

  test('自動配信 (broadcast / scenario) のメッセージは sentByStaffName が null', async () => {
    const { db } = fakeDb([
      {
        id: 'msg-broadcast',
        friend_id: 'friend-1',
        direction: 'outgoing',
        content: '一斉配信のお知らせ',
        created_at: '2026-09-03T09:00:00.000+09:00',
        source: 'broadcast',
      },
      {
        id: 'msg-scenario',
        friend_id: 'friend-1',
        direction: 'outgoing',
        content: 'ステップ配信',
        created_at: '2026-09-03T09:30:00.000+09:00',
        source: 'scenario',
      },
    ]);

    const res = await get(db);

    const { data } = await getBody(res);
    expect(data.messages.map((m) => m.sentByStaffName)).toEqual([null, null]);
  });

  test('送信した手動メッセージが GET のレスポンスに送信者名付きで現れる', async () => {
    const { db } = fakeDb();

    const sent = await send(db, { messageType: 'text', content: '折り返しご連絡します' }, STAFF);
    expect(sent.status).toBe(200);

    const res = await get(db);
    const { data } = await getBody(res);
    expect(data.messages.at(-1)).toMatchObject({ sentByStaffName: '佐藤花子' });
  });
});
