import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

// 引用リプライ (quoteToken) の保存だけを見るテスト。DB / LINE には触らず、
// messages_log への INSERT に quote_token が bind されるかを検証する。
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/activity-mileage.js', () => ({
  awardActivityMileage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/auto-reply.js', () => ({
  matchAndReply: vi.fn().mockResolvedValue({ matched: false, replyTokenConsumed: false }),
}));

vi.mock('../services/immediate-first-step.js', () => ({
  pushImmediateFirstStep: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

import { verifySignature } from '@line-crm/line-sdk';
import { getFriendByLineUserId, jstNow, upsertChatOnMessage } from '@line-crm/db';
import { webhook } from './webhook.js';

type Query = { sql: string; params: unknown[] };

function fakeDb() {
  const queries: Query[] = [];
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
          return {};
        },
        async all() {
          queries.push({ sql, params: statement.params });
          return { results: [] };
        },
        async first() {
          queries.push({ sql, params: statement.params });
          return null;
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, queries };
}

const baseEnv = {
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const friendRow = {
  id: 'friend-1',
  line_user_id: 'U-quoter',
  display_name: 'Quoter',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: null,
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-09-03T12:00:00.000+09:00',
  updated_at: '2026-09-03T12:00:00.000+09:00',
};

function messageLogInsert(queries: Query[]): Query | undefined {
  return queries.find((q) => q.sql.includes('INSERT INTO messages_log'));
}

async function postEvent(db: D1Database, message: Record<string, unknown>) {
  const app = new Hono();
  app.route('/', webhook);
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;

  const res = await app.request(
    '/webhook',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': 'A'.repeat(43) + '=',
      },
      body: JSON.stringify({
        destination: 'bot',
        events: [
          {
            type: 'message',
            replyToken: 'reply-token',
            message,
            timestamp: Date.now(),
            source: { type: 'user', userId: 'U-quoter' },
            webhookEventId: 'event-1',
            deliveryContext: { isRedelivery: false },
            mode: 'active',
          },
        ],
      }),
    },
    { ...baseEnv, DB: db },
    executionCtx,
  );

  const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
  await processing;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifySignature).mockResolvedValue(true);
  vi.mocked(getFriendByLineUserId).mockResolvedValue(friendRow);
  vi.mocked(jstNow).mockReturnValue('2026-09-03T12:00:00.000+09:00');
  vi.mocked(upsertChatOnMessage).mockResolvedValue({
    id: 'chat-1',
    friend_id: 'friend-1',
    operator_id: null,
    status: 'unread',
    notes: null,
    last_message_at: '2026-09-03T12:00:00.000+09:00',
    created_at: '2026-09-03T12:00:00.000+09:00',
    updated_at: '2026-09-03T12:00:00.000+09:00',
  });
});

describe('POST /webhook — quoteToken の保存', () => {
  test('テキスト受信時に quote_token を messages_log に保存する', async () => {
    const { db, queries } = fakeDb();
    const res = await postEvent(db, {
      type: 'text',
      id: 'message-1',
      text: 'こんにちは',
      quoteToken: 'quote-token-text',
    });

    expect(res.status).toBe(200);
    const insert = messageLogInsert(queries);
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('quote_token');
    expect(insert!.params).toContain('quote-token-text');
  });

  test('quoteToken が無いテキスト受信は quote_token に NULL を入れる', async () => {
    const { db, queries } = fakeDb();
    await postEvent(db, { type: 'text', id: 'message-1', text: 'こんにちは' });

    const insert = messageLogInsert(queries);
    expect(insert).toBeDefined();
    // (id, friend_id, content, quote_token, created_at) の順で bind される
    expect(insert!.params).toEqual([
      expect.any(String),
      'friend-1',
      'こんにちは',
      null,
      '2026-09-03T12:00:00.000+09:00',
    ]);
  });

  test('非テキスト (画像) 受信時にも quote_token を保存する', async () => {
    const { db, queries } = fakeDb();
    const res = await postEvent(db, {
      type: 'image',
      id: 'message-2',
      quoteToken: 'quote-token-image',
    });

    expect(res.status).toBe(200);
    const insert = messageLogInsert(queries);
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('quote_token');
    expect(insert!.params).toContain('quote-token-image');
  });
});
