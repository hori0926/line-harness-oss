import { claimChatLease } from '../services/chat-lease.js';
import { Hono } from 'hono';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getOperators,
  getOperatorById,
  createOperator,
  updateOperator,
  deleteOperator,
  getChats,
  getChatById,
  createChat,
  getFriendById,
  getLineAccountById,
  resolveDefaultAccessToken,
  updateChat,
  jstNow,
  toJstString,
} from '@line-crm/db';
import type { Env } from '../index.js';

const chats = new Hono<Env>();

function clampLoadingSeconds(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 5;
  return Math.min(60, Math.max(5, n));
}

async function startLoadingAnimation(
  accessToken: string,
  chatId: string,
  loadingSeconds: number,
): Promise<void> {
  const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatId, loadingSeconds }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail
        ? `LINE API error: ${response.status} - ${detail}`
        : `LINE API error: ${response.status}`,
    );
  }
}

type ChatLike = {
  id: string;
  friend_id: string;
  operator_id: string | null;
  status: string;
  notes: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

// id は chats.id もしくは friend.id のどちらか。friend.id のときは chats 行を遅延作成する。
// push / broadcast / scenario 配信だけを受けた友だちもチャット画面に現れるため、ここで lazy create が必要。
// 新規作成する場合は status='resolved' にし、last_message_at は messages_log の実際の最終時刻を使う
// （jstNow を入れると一覧並び順が壊れるため）。
async function resolveOrCreateChat(db: D1Database, id: string): Promise<ChatLike | null> {
  const existing = await getChatById(db, id);
  if (existing) return existing as ChatLike;
  const friend = await getFriendById(db, id);
  if (!friend) return null;
  // 最新行を選ぶ (unanswered-inbox / conversations の latest_chat CTE と同じ基準)。
  // 最古行を選ぶと、旧重複データがある DB で読み手と別の行に status を書いてしまう。
  const byFriend = await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>();
  if (byFriend) return byFriend;

  const lastMsg = await db
    .prepare(
      `SELECT MAX(created_at) AS last FROM messages_log WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')`,
    )
    .bind(friend.id)
    .first<{ last: string | null }>();
  const newId = crypto.randomUUID();
  const now = jstNow();
  const lastMessageAt = lastMsg?.last ?? null;
  // 同時実行で二重挿入されないように WHERE NOT EXISTS + OR IGNORE で原子挿入。
  // 挿入結果に関わらず最新行を返して収束。
  await db
    .prepare(
      `INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       SELECT ?, ?, 'resolved', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
    )
    .bind(newId, friend.id, lastMessageAt, now, now, friend.id)
    .run();
  return (await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>())!;
}

/**
 * 差分ポーリング用 `?since=` の正規化。
 *
 * DB の messages_log.created_at は全ての書き込み経路が jstNow() を明示 bind して
 * いるので 'YYYY-MM-DDTHH:mm:ss.sss+09:00' 固定。SQLite の比較は文字列比較なので、
 * UTC の 'Z' 表記などで来ても正しく効くように同じ JST 表記へ寄せてから使う
 * (フロントが受け取った createdAt をそのまま返す場合は round-trip で不変)。
 *
 * パースできない値は **エラーにせず null (= 全件取得) にフォールバック** する。
 * ポーリングが 400 で壊れて画面が凍るより、多めに読むほうが運用上安全。
 */
function normalizeSince(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return toJstString(parsed);
}

/**
 * `envAccessToken` は「最後の砦」であって既定値ではない —
 * `resolveDefaultAccessToken` の doc comment を参照。friend にアカウントが
 * 紐付いていなくても、テナントに有効なアカウントが1本しか無ければそれを使う。
 */
async function resolveFriendAndAccessToken(
  db: D1Database,
  friendId: string,
  envAccessToken: string,
) {
  const friend = await getFriendById(db, friendId);
  if (!friend) {
    return { friend: null, accessToken: await resolveDefaultAccessToken(db, envAccessToken) };
  }

  if (!friend.line_account_id) {
    return { friend, accessToken: await resolveDefaultAccessToken(db, envAccessToken) };
  }

  const account = await getLineAccountById(db, friend.line_account_id);
  if (!account) {
    return { friend, accessToken: await resolveDefaultAccessToken(db, envAccessToken) };
  }

  return { friend, accessToken: account.channel_access_token };
}

// ========== オペレーターCRUD ==========

chats.get('/api/operators', async (c) => {
  try {
    const items = await getOperators(c.env.DB);
    return c.json({
      success: true,
      data: items.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        role: o.role,
        isActive: Boolean(o.is_active),
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/operators error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/operators', async (c) => {
  try {
    const body = await c.req.json<{ name: string; email: string; role?: string }>();
    if (!body.name || !body.email) return c.json({ success: false, error: 'name and email are required' }, 400);
    const item = await createOperator(c.env.DB, body);
    return c.json({ success: true, data: { id: item.id, name: item.name, email: item.email, role: item.role } }, 201);
  } catch (err) {
    console.error('POST /api/operators error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.put('/api/operators/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateOperator(c.env.DB, id, body);
    const updated = await getOperatorById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error('PUT /api/operators/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.delete('/api/operators/:id', async (c) => {
  try {
    await deleteOperator(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/operators/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== チャットCRUD ==========

chats.get('/api/chats', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const operatorId = c.req.query('operatorId') ?? undefined;
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const unansweredOnly =
      c.req.query('unansweredOnly') === 'true' || c.req.query('unansweredOnly') === '1';

    let unansweredMap: Map<string, { lastIncomingAt: string; lastIncomingContent: string; lastIncomingType: string }> | null = null;
    if (unansweredOnly) {
      const { getUnansweredRowsMap } = await import('../services/unanswered-inbox.js');
      unansweredMap = await getUnansweredRowsMap(c.env.DB);
      // 空 Map のとき = 未対応ゼロ。早期 return で空配列を返す。
      if (unansweredMap.size === 0) {
        return c.json({ success: true, data: [] });
      }
    }

    // List everyone who has any message history (incoming or outgoing — push/broadcast/scenario included)
    // PLUS any chats row that exists even before any messages_log entry is written.
    // Source = messages_log ∪ chats.friend_id; chats は status/operator/notes 用に LEFT JOIN で最新1件だけ採用。
    //
    // recent_msg CTE で friend_id ごとに最新の messages_log 行をひとつ取得し、本文 preview と
    // direction (incoming/outgoing) を一覧に出す。
    //
    // パフォーマンス対策 (2026-07-06 本番実測で全面改修):
    //   旧実装は messages_log (96k 行) を ROW_NUMBER × 2 + GROUP BY で 3 回スキャンし、
    //   さらに LIMIT なしで全 friend (10k 行) を返していた → 本番 D1 実測 3.47 秒 / 781k rows_read。
    //   新実装は (a) ROW_NUMBER を argmax GROUP BY に置換 (SQLite の bare-column +
    //   単一 MAX() は max 行の値を返す documented 挙動)、(b) CTE を MATERIALIZED して
    //   二重評価を防止、(c) page CTE で先に対象 friend を limit 件に確定してから
    //   preview を計算、(d) デフォルト LIMIT 300 (最終行は last_message_at DESC)。
    //   同条件の本番実測: 459ms / 165k rows_read (LIMIT 300 時)。
    //   - content は text のみ先頭 200 文字まで切り詰めて返す (flex/image など raw JSON を
    //     返すと broadcast 後の rows で multi-MB レスポンスになる)。
    //   - lineAccountId 指定時は messages_log スキャンを対象アカの friend に絞る。
    const accountFilterSql = lineAccountId
      ? `friend_id IN (SELECT id FROM friends WHERE line_account_id = ?)`
      : `1=1`;

    // unansweredOnly は取得後に unansweredMap と突合して絞るため全件必要。
    // SQLite は LIMIT に負値を渡すと「無制限」になる (documented 挙動)。
    const NO_LIMIT = -1;
    const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = unansweredOnly
      ? NO_LIMIT
      : Number.isFinite(limitParam)
        ? Math.min(1000, Math.max(1, limitParam))
        : 300;
    // カーソルページング: (last_message_at, friend_id) の複合カーソルより古い行を返す。
    // offset 方式は「取得の合間に新着で行が押し下げられた分が欠落する」構造問題が
    // あるため採用しない。friend_id は同時刻 (broadcast 一斉配信等) のタイブレーク。
    const beforeAt = c.req.query('beforeAt') || undefined;
    const beforeId = c.req.query('beforeId') || undefined;
    const useCursor = !unansweredOnly && Boolean(beforeAt && beforeId);

    const conditions: string[] = [];
    const conditionBindings: unknown[] = [];
    if (status) {
      conditions.push(`COALESCE(c.status, 'resolved') = ?`);
      conditionBindings.push(status);
    }
    if (operatorId) {
      conditions.push('c.operator_id = ?');
      conditionBindings.push(operatorId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      conditionBindings.push(lineAccountId);
    }
    // status / operator filter は chats を参照するので、その時だけ page CTE 側でも
    // chats を lookup する (無条件時は 全friend × chats lookup を省く)。
    const pageNeedsChats = Boolean(status || operatorId);

    // preview は direction/source を問わず **実際の最新メッセージ** を表示する。
    // incoming を常に優先すると、プロキシ経由の manual/external 送信が messages_log に
    // 正しく保存されていても、一覧には何日も前の incoming とその日時が残って見える。
    // また page の並び順は最新 any なのにレスポンスの lastMessageAt だけ過去の incoming に
    // なるため、フロントが作るページング cursor と SQL のソートキーも食い違っていた。
    // 未対応モードだけは取得後に unansweredMap の incoming で明示的に上書きする。
    // text 以外 (flex/image/sticker 等) は content を NULL にして payload size を抑える
    // (フロントは type で 📋 Flex / 📷 画像 等のラベルを出すので content は不要)。
    // any_agg の bare column (content 等) は「単一 MAX() を含む集約は max 行の
    // 値を返す」という SQLite の documented 挙動で argmax として使っている。
    // 集約は page 確定後の friend に絞って実行する (全 friend 分の content を
    // materialize しない)。last_any は並び順決定専用のスリムな全走査 1 回のみ。
    const sql = `
      WITH last_any AS MATERIALIZED (
        SELECT friend_id, MAX(created_at) AS last_message_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
        GROUP BY friend_id
      ),
      deduped AS MATERIALIZED (
        SELECT friend_id, MAX(last_message_at) AS last_message_at FROM (
          SELECT friend_id, last_message_at FROM last_any
          UNION ALL
          SELECT friend_id, last_message_at FROM chats WHERE ${accountFilterSql}
        ) GROUP BY friend_id
      ),
      page AS MATERIALIZED (
        SELECT d.friend_id, d.last_message_at
        FROM deduped d
        INNER JOIN friends f ON f.id = d.friend_id
        ${pageNeedsChats ? `LEFT JOIN chats c ON c.id = (
          SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
        )` : ''}
        WHERE 1=1
        ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
        ${useCursor ? 'AND (d.last_message_at < ? OR (d.last_message_at = ? AND d.friend_id < ?))' : ''}
        ORDER BY d.last_message_at DESC, d.friend_id DESC
        LIMIT ?
      ),
      any_agg AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type,
          MAX(created_at) AS created_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND friend_id IN (SELECT friend_id FROM page)
        GROUP BY friend_id
      ),
      recent_msg AS (
        SELECT friend_id, content, direction, message_type, created_at AS preview_at
        FROM any_agg
      )
      SELECT
        f.id AS id,
        f.id AS friend_id,
        f.display_name,
        f.picture_url,
        f.line_user_id,
        f.line_account_id,
        c.operator_id,
        COALESCE(c.status, 'resolved') AS status,
        c.notes,
        COALESCE(rm.preview_at, d.last_message_at) AS last_message_at,
        rm.content AS last_message_content,
        rm.direction AS last_message_direction,
        rm.message_type AS last_message_type,
        COALESCE(c.created_at, d.last_message_at) AS created_at,
        COALESCE(c.updated_at, d.last_message_at) AS updated_at
      FROM page d
      INNER JOIN friends f ON f.id = d.friend_id
      LEFT JOIN chats c ON c.id = (
        SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN recent_msg rm ON rm.friend_id = f.id
      ORDER BY d.last_message_at DESC, d.friend_id DESC
    `;

    // placeholder 順 = SQL 出現順: last_any(account) → deduped 内 chats(account) →
    // page 条件 → cursor (beforeAt ×2 + beforeId) → LIMIT。
    // any_agg は page で friend が確定済みのため account filter 不要。
    const allBindings: unknown[] = [];
    if (lineAccountId) allBindings.push(lineAccountId, lineAccountId);
    allBindings.push(...conditionBindings);
    if (useCursor) allBindings.push(beforeAt, beforeAt, beforeId);
    allBindings.push(limit);
    const result = await c.env.DB.prepare(sql).bind(...allBindings).all();

    let data = result.results.map((ch: Record<string, unknown>) => ({
      id: ch.id as string,
      friendId: ch.friend_id,
      friendName: ch.display_name || '名前なし',
      friendPictureUrl: ch.picture_url || null,
      operatorId: ch.operator_id,
      status: ch.status,
      notes: ch.notes,
      lastMessageAt: ch.last_message_at,
      lastMessageContent: ch.last_message_content || null,
      lastMessageDirection: ch.last_message_direction || null,
      lastMessageType: ch.last_message_type || null,
      createdAt: ch.created_at,
      updatedAt: ch.updated_at,
    }));

    if (unansweredMap) {
      // 未対応 row の preview / timestamp で上書きして Inbox と一貫させる
      data = data
        .filter((row) => unansweredMap!.has(row.id as string))
        .map((row) => {
          const u = unansweredMap!.get(row.id as string)!;
          return {
            ...row,
            lastMessageAt: u.lastIncomingAt,
            lastMessageContent: u.lastIncomingType === 'text' ? u.lastIncomingContent : null,
            lastMessageDirection: 'incoming' as const,
            lastMessageType: u.lastIncomingType,
          };
        })
        // 上書きで lastMessageAt が変わったので resort
        .sort((a, b) => {
          const aAt = typeof a.lastMessageAt === 'string' ? a.lastMessageAt : '';
          const bAt = typeof b.lastMessageAt === 'string' ? b.lastMessageAt : '';
          return bAt.localeCompare(aAt);
        });
    }

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Indexed change marker: polling this avoids repeatedly scanning message history.
chats.get('/api/chats/activity', async (c) => {
  const latest = await c.env.DB.prepare('SELECT updated_at FROM chats ORDER BY updated_at DESC LIMIT 1').first<{ updated_at: string }>();
  return c.json({ success: true, data: { version: latest?.updated_at ?? '' } });
});

chats.get('/api/chats/:id', async (c) => {
  try {
    const rawId = c.req.param('id');

    // id は chats.id または friend.id のどちらでもOK。
    // 優先順: chats.id 一致 → friend.id のとき chats.friend_id 最新行 → 何も無ければ friend のみで synthetic
    let chatRow = await getChatById(c.env.DB, rawId);
    let friendId: string | null = null;

    if (!chatRow) {
      const friendRow = await getFriendById(c.env.DB, rawId);
      if (!friendRow) return c.json({ success: false, error: 'Chat not found' }, 404);
      friendId = friendRow.id;
      // 同じ friend に紐づく chats 行があれば採用（lazy-create 後の再読みで status/notes を拾うため）
      const existing = await c.env.DB
        .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(friendRow.id)
        .first<{ id: string; friend_id: string; operator_id: string | null; status: string; notes: string | null; last_message_at: string | null; created_at: string; updated_at: string }>();
      if (existing) {
        chatRow = existing as Awaited<ReturnType<typeof getChatById>>;
      }
    }

    const resolvedFriendId = chatRow?.friend_id ?? friendId!;
    // 公開 ID は常に friend_id に統一する（lazy-create で ID が変わるのを防ぐため）。
    const responseId = resolvedFriendId;
    const operatorId = chatRow?.operator_id ?? null;
    const status = chatRow?.status ?? 'resolved';
    const notes = chatRow?.notes ?? null;
    const lastMessageAt = chatRow?.last_message_at ?? null;
    const createdAt = chatRow?.created_at ?? null;

    const friend = await c.env.DB
      .prepare(`SELECT display_name, picture_url, line_user_id FROM friends WHERE id = ?`)
      .bind(resolvedFriendId)
      .first<{ display_name: string | null; picture_url: string | null; line_user_id: string }>();

    // 差分取得。`?since=` があるとその時刻より後のメッセージだけを返す。
    //
    // なぜ必要か: 全件モードは 1 リクエストで最大1000行を読む。フロントが10秒間隔で
    // ポーリングすると オペレーター5人 × 8時間 × 6回/分 × 1000行 ≈ 1,440万行/日 になり、
    // D1 無料枠 (500万行/日) を軽く超える。差分が無いとポーリング自体を導入できない。
    //
    // 比較は **包含 (`>=`)**。created_at はミリ秒精度なので、since と同時刻に
    // 別メッセージが後着することがある。`>` だとその行を永久に取りこぼす。
    // 境界の既存行も再取得されるが、フロントの mergeMessages が id で重複除去する。
    const since = normalizeSince(c.req.query('since'));
    const isDelta = since !== null;

    // 新しい1000件を取って昇順に戻す。LIMIT 200 ASC だと古い200件だけで broadcast/scenario 等の
    // 新しい push が欠落していた（Shu で 481件中 281件欠落のバグあり）。一覧側と同様に test 配信は除外。
    // 現状の最重量ユーザー(481件)の2倍バッファ。これ以上の履歴はページング未実装（Phase 2 TODO）。
    //
    // 差分モードは既に昇順で取れるので reverse しない。LIMIT 200 は「10秒の間に
    // 200件を超えて届く」ことが 1:1 チャットでは起き得ないため十分で、万一溢れても
    // 次回の since が進むので取りこぼしにはならない。
    const messages = isDelta
      ? await c.env.DB
          .prepare(
            `SELECT id, friend_id, direction, message_type, content, quote_token, quoted_message_id, sent_by_staff_name, created_at, content_updated_at
             FROM messages_log
             WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')
               AND (created_at >= ? OR content_updated_at >= ?)
             ORDER BY COALESCE(content_updated_at, created_at) ASC, id ASC LIMIT 200`,
          )
          .bind(resolvedFriendId, since, since)
          .all()
      : await c.env.DB
          .prepare(
            `SELECT id, friend_id, direction, message_type, content, quote_token, quoted_message_id, sent_by_staff_name, created_at, content_updated_at
             FROM messages_log
             WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')
             ORDER BY created_at DESC LIMIT 1000`,
          )
          .bind(resolvedFriendId)
          .all();
    if (!isDelta) {
      messages.results = (messages.results as Record<string, unknown>[]).reverse();
    }

    return c.json({
      success: true,
      data: {
        id: responseId,
        friendId: resolvedFriendId,
        friendName: friend?.display_name || '名前なし',
        friendPictureUrl: friend?.picture_url || null,
        operatorId,
        status,
        notes,
        lastMessageAt,
        createdAt,
        // このレスポンスが差分かどうか。true ならフロントは messages を既存配列に
        // マージし、false なら置き換える。status / notes などメッセージ以外の
        // フィールドは isDelta に関わらず常に最新の完全な値を返しているので、
        // 差分レスポンスでもそのまま反映してよい (会話のステータス変化を
        // ポーリングで検知できる)。
        isDelta,
        messages: (messages.results as Record<string, unknown>[]).map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          contentUpdatedAt: m.content_updated_at ?? null,
          // quoteToken の実値は返さない (フロントは引用可否しか使わず、
          // 送信時に渡すのは quotedMessageId のみ)。トークンは秘密情報として扱う。
          quotable: Boolean(m.quote_token),
          // 引用プレビューを同じ messages 配列から解決するために必要
          quotedMessageId: (m.quoted_message_id as string | null) ?? null,
          // 手動返信を送ったスタッフ名。自動配信 (broadcast / scenario) は null。
          // sent_by_staff_id は返さない — フロントは表示名しか使わないので、
          // 使わない内部 ID を露出しない (quotable / quoteToken と同じ判断)。
          sentByStaffName: (m.sent_by_staff_name as string | null) ?? null,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats', async (c) => {
  try {
    const body = await c.req.json<{ friendId: string; operatorId?: string; lineAccountId?: string | null }>();
    if (!body.friendId) return c.json({ success: false, error: 'friendId is required' }, 400);
    const item = await createChat(c.env.DB, body);
    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, friendId: item.friend_id, status: item.status } }, 201);
  } catch (err) {
    console.error('POST /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// チャットのアサイン/ステータス更新/ノート更新
chats.put('/api/chats/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = await resolveOrCreateChat(c.env.DB, id);
    if (!resolved) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<{ operatorId?: string | null; status?: string; notes?: string }>();
    await updateChat(c.env.DB, resolved.id, body);
    const updated = await getChatById(c.env.DB, resolved.id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      // 公開 ID は friend_id に統一
      data: { id: updated.friend_id, friendId: updated.friend_id, operatorId: updated.operator_id, status: updated.status, notes: updated.notes },
    });
  } catch (err) {
    console.error('PUT /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Browsing a conversation claims a short lease; other staff can still read it.
chats.post('/api/chats/:id/lease', async (c) => {
  if (c.env.MANUAL_REPLY_ONLY !== 'true') return c.json({ success: true, data: { owned: true, staffName: '', expiresAt: 0 } });
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'ログインが必要です' }, 401);
  const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
  if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
  return c.json({ success: true, data: await claimChatLease(c.env.DB, chat.friend_id, staff) });
});

// オペレーター入力中のローディング表示を開始
chats.post('/api/chats/:id/loading', async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    let loadingSecondsInput: number | undefined;
    try {
      const body = await c.req.json<{ loadingSeconds?: number }>();
      loadingSecondsInput = body.loadingSeconds;
    } catch {
      loadingSecondsInput = undefined;
    }
    const loadingSeconds = clampLoadingSeconds(loadingSecondsInput);

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    await startLoadingAnimation(
      accessToken,
      friend.line_user_id,
      loadingSeconds,
    );

    return c.json({ success: true, data: { started: true, loadingSeconds } });
  } catch (err) {
    console.error('POST /api/chats/:id/loading error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return c.json({ success: false, error: message }, 500);
  }
});

// オペレーターからメッセージ送信
chats.post('/api/chats/:id/send', async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    if (c.env.MANUAL_REPLY_ONLY === 'true') {
      const staff = c.get('staff');
      if (!staff) return c.json({ success: false, error: 'ログインが必要です' }, 401);
      const lease = await claimChatLease(c.env.DB, chat.friend_id, staff);
      if (!lease.owned) return c.json({ success: false, error: `${lease.staffName}が対応中です。送信していません。` }, 409);
    }

    const body = await c.req.json<{ messageType?: string; content: string; quotedMessageId?: string; requestId?: string }>();
    if (!body.content) return c.json({ success: false, error: 'content is required' }, 400);

    const messageType = body.messageType ?? 'text';
    if (!['text', 'image', 'flex'].includes(messageType) || typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ success: false, error: '対応していない送信形式、または本文が空です' }, 400);
    }

    // 空文字は「引用なし」として扱う (DB に '' を残さない)
    const quotedMessageId = body.quotedMessageId || null;

    // 引用リプライは text のみ対応 (画像・Flex の引用は LINE 側の可否が確定できないため対象外)
    if (quotedMessageId && messageType !== 'text') {
      return c.json(
        { success: false, error: '引用リプライはテキストメッセージのみ対応しています' },
        400,
      );
    }

    // 引用元の quoteToken を取得する。
    // ⚠️ friend_id での絞り込みは必須 — id だけで引くと、他人の会話の messages_log.id を
    //    渡すだけで別の友だちの quoteToken を引用できてしまう (越境)。
    let quoteToken: string | null = null;
    if (quotedMessageId) {
      const quoted = await c.env.DB
        .prepare(`SELECT quote_token FROM messages_log WHERE id = ? AND friend_id = ?`)
        .bind(quotedMessageId, chat.friend_id)
        .first<{ quote_token: string | null }>();
      if (!quoted || !quoted.quote_token) {
        // 黙って引用なしで送らない。オペレーターは引用したくて送っているので明示的に失敗させる。
        return c.json(
          { success: false, error: '引用元のメッセージが見つからないか、引用できません' },
          400,
        );
      }
      quoteToken = quoted.quote_token;
    }

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    // LINE APIでメッセージ送信
    const { LineClient, extractSentQuoteToken } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken);

    const requestId = body.requestId;
    if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return c.json({ success: false, error: '送信IDが不正です' }, 400);
    }
    if (c.env.MANUAL_REPLY_ONLY === 'true' && !requestId) {
      return c.json({ success: false, error: '画面を更新してから送信してください' }, 400);
    }
    if (requestId) {
      const payload = JSON.stringify({ messageType, content: body.content, quotedMessageId });
      const staffId = c.get('staff')?.id ?? 'unknown';
      await c.env.DB.prepare(`INSERT OR IGNORE INTO manual_send_requests (request_id,friend_id,staff_id,payload,created_at)
        VALUES (?,?,?,?,?)`).bind(requestId, friend.id, staffId, payload, Date.now()).run();
      const saved = await c.env.DB.prepare('SELECT * FROM manual_send_requests WHERE request_id = ?').bind(requestId)
        .first<{ friend_id: string; staff_id: string; payload: string; sent: number; created_at: number }>();
      if (!saved || saved.friend_id !== friend.id || saved.staff_id !== staffId || saved.payload !== payload) {
        return c.json({ success: false, error: '送信IDが別の操作に使用されています' }, 409);
      }
      if (saved.sent) return c.json({ success: true, data: { sent: true, messageId: `manual:${requestId}` } });
      // LINE retry keys expire at 24h. Never risk a second push after that window.
      if (Date.now() - saved.created_at > 23 * 60 * 60 * 1000) {
        return c.json({ success: false, error: '送信結果が未確定です。履歴を確認し、管理者に連絡してください' }, 409);
      }
    }
    let pushResponse: unknown = null;
    if (requestId) {
      const message = messageType === 'text'
        ? { type: 'text' as const, text: body.content, ...(quoteToken ? { quoteToken } : {}) }
        : messageType === 'image'
          ? { type: 'image' as const, originalContentUrl: JSON.parse(body.content).originalContentUrl, previewImageUrl: JSON.parse(body.content).previewImageUrl }
          : { type: 'flex' as const, altText: extractFlexAltText(JSON.parse(body.content)), contents: JSON.parse(body.content) };
      pushResponse = await lineClient.pushMessage(friend.line_user_id, [message], requestId);
    } else if (messageType === 'text') {
      pushResponse = await lineClient.pushTextMessage(
        friend.line_user_id,
        body.content,
        quoteToken ?? undefined,
      );
    } else if (messageType === 'flex') {
      const contents = JSON.parse(body.content);
      pushResponse = await lineClient.pushFlexMessage(
        friend.line_user_id,
        extractFlexAltText(contents),
        contents,
      );
    } else if (messageType === 'image') {
      const parsed = JSON.parse(body.content) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      pushResponse = await lineClient.pushImageMessage(
        friend.line_user_id,
        parsed.originalContentUrl,
        parsed.previewImageUrl,
      );
    }

    // 送信済みメッセージの quoteToken を控えておくと、オペレーター自身が送った
    // メッセージも後から引用できる (LINE アプリと同じ挙動)。
    // 取れなくても送信は成功しているので、ここでは決して失敗させない
    // (例外を投げるとオペレーターが再送し二重送信になる)。/line-api プロキシの
    // 「ログ失敗は送信を壊さない」方針に揃える。
    let sentQuoteToken: string | null = null;
    try {
      sentQuoteToken = extractSentQuoteToken(pushResponse);
    } catch (err) {
      console.error('POST /api/chats/:id/send quoteToken extraction failed:', err);
    }

    // 送信スタッフを記録する (複数スタッフ運用で「誰が返したか」を残すため)。
    // authMiddleware が /api/ 全体に掛かっていて c.set('staff', staff) 済みなので
    // 通常は必ず取れるが、取れない経路 (env API_KEY での owner フォールバックが
    // 将来変わる / テスト等) でも **送信は絶対に失敗させない** — 両方 NULL で記録する。
    // 名前は送信時点のスナップショット: staff 行が削除されても監査記録を残すため。
    const staff = c.get('staff');
    const sentByStaffId = staff?.id ?? null;
    const sentByStaffName = staff?.name ?? null;

    // メッセージログに記録
    const logId = requestId ? `manual:${requestId}` : crypto.randomUUID();
    await c.env.DB
      .prepare(`INSERT OR IGNORE INTO messages_log (id, friend_id, direction, message_type, content, source, quote_token, quoted_message_id, sent_by_staff_id, sent_by_staff_name, created_at) VALUES (?, ?, 'outgoing', ?, ?, 'manual', ?, ?, ?, ?, ?)`)
      .bind(logId, friend.id, messageType, body.content, sentQuoteToken, quotedMessageId, sentByStaffId, sentByStaffName, jstNow())
      .run();

    // チャットの最終メッセージ日時を更新（chat.id を直接使う — friend_id で呼ばれても resolveOrCreateChat 済み）
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', lastMessageAt: jstNow() });

    if (requestId) await c.env.DB.prepare('UPDATE manual_send_requests SET sent = 1 WHERE request_id = ?').bind(requestId).run();
    return c.json({ success: true, data: { sent: true, messageId: logId } });
  } catch (err) {
    console.error('POST /api/chats/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { chats };
