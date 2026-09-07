import type {
  BroadcastRequest,
  FlexContainer,
  Message,
  MulticastRequest,
  PushMessageRequest,
  ReplyMessageRequest,
  PushMessageResponse,
  RichMenuObject,
  TextMessage,
  UserProfile,
} from './types.js';

const LINE_API_BASE_DEFAULT = 'https://api.line.me';
const LINE_CONTENT_API_BASE_DEFAULT = 'https://api-data.line.me';

// ─── ローカル開発専用: LINE API のベース URL 差し替え ────────────────────────
//
// ⚠️ 警告 — これは **ローカル開発でモックサーバーに向けるためだけ** の逃げ道です。
//
//   本番・ステージングを含め、実際の顧客が友だち登録している LINE 公式アカウントを
//   扱う環境では絶対に設定しないでください。ここを設定するということは、
//   「チャネルアクセストークン」「友だちの LINE userId」「送受信メッセージ本文」
//   「受信した画像・動画・PDF などのファイル本体」を、指定したホストへそのまま
//   送り出すということです。設定ミス・タイプミス・コピーした .dev.vars の
//   混入によって、顧客の個人情報とトークンが第三者のサーバーへ流出する経路に
//   なり得ます。**設定した覚えのない環境では必ず未設定にしてください。**
//
//   未設定 (null / 空文字) のときは既定の本番 URL が使われ、挙動は従来と
//   完全に同一です。この関数を呼ばない限り何も変わりません。
//
// 呼び出しは apps/worker/src/middleware/line-api-base.ts から
// 環境変数 (LINE_API_BASE_URL / LINE_CONTENT_API_BASE_URL) を渡して行います。
// module スコープに置いているのは、`new LineClient(token)` の呼び出し箇所が
// コードベース全体に散っており、全部にベース URL を引き回すと本番コードの
// シグネチャを開発都合で汚すため。
let lineApiBaseOverride: string | null = null;
let lineContentApiBaseOverride: string | null = null;

function normalizeBase(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * ローカル開発でのみ使うベース URL の上書き。**上の警告を必ず読むこと。**
 * どちらも未指定 / 空なら本番の URL に戻る (= 既定の挙動)。
 */
export function configureLineApiBase(options: {
  apiBaseUrl?: string | null;
  contentApiBaseUrl?: string | null;
}): void {
  lineApiBaseOverride = normalizeBase(options.apiBaseUrl);
  lineContentApiBaseOverride = normalizeBase(options.contentApiBaseUrl);
  if (lineApiBaseOverride || lineContentApiBaseOverride) {
    // 本番で万一設定された場合に気づけるよう、必ず 1 行残す。
    console.warn(
      '[line-sdk] LINE API base URL overridden (LOCAL DEV ONLY) — api=%s content=%s',
      lineApiBaseOverride ?? LINE_API_BASE_DEFAULT,
      lineContentApiBaseOverride ?? LINE_CONTENT_API_BASE_DEFAULT,
    );
  }
}

/** Messaging API のベース URL。未設定なら https://api.line.me。 */
export function getLineApiBase(): string {
  return lineApiBaseOverride ?? LINE_API_BASE_DEFAULT;
}

/** Content API (バイナリ配信) のベース URL。未設定なら https://api-data.line.me。 */
export function getLineContentApiBase(): string {
  return lineContentApiBaseOverride ?? LINE_CONTENT_API_BASE_DEFAULT;
}

export interface FollowersInsight {
  status: string;
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
}

export interface FollowerIdsPage {
  userIds: string[];
  next?: string;
}

export interface MessageQuota {
  /** 'limited' (value holds the plan's monthly cap) or 'none' (no cap). */
  type: string;
  value?: number;
}

export interface MessageQuotaConsumption {
  totalUsage: number;
}

/**
 * LINE API が非 2xx を返したときの typed error。status とレスポンス本文を
 * 機械可読に保持する — 呼び出し元が「429 かつ月間上限超過」のような判別を
 * message 文字列のパースなしで行えるようにする。
 */
export class LineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBody: string,
  ) {
    super(`LINE API error: ${status} ${statusText} — ${responseBody}`);
    this.name = 'LineApiError';
  }
}

export class LineClient {
  constructor(private readonly channelAccessToken: string) {}

  // ─── Core request helper ──────────────────────────────────────────────────

  async request(
    method: string,
    path: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {},
  ): Promise<{ data: unknown; headers: Headers }> {
    const url = `${getLineApiBase()}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
        ...requestHeaders,
      },
    };

    if (method !== 'GET' && method !== 'DELETE' && body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    // LINE returns 409 when a request with the same X-Line-Retry-Key was
    // already accepted. For a caller retrying the exact same operation this
    // is a successful idempotent outcome, not a delivery failure.
    if (res.status === 409 && requestHeaders['X-Line-Retry-Key']) {
      return { data: { retryAccepted: true }, headers: res.headers };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LineApiError(res.status, res.statusText, text);
    }

    // Some endpoints (e.g. push, reply) return an empty body with 200.
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = undefined;
    }

    return { data, headers: res.headers };
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/profile/${encodeURIComponent(userId)}`,
    );
    return data as UserProfile;
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  /**
   * push 送信。戻り値の sentMessages[].quoteToken を保存しておくと、
   * あとから「自分が送ったメッセージ」も引用リプライの引用元にできる。
   * LINE 側の仕様変更や 409 (retry key 済み) では sentMessages が無いので、
   * 取り出しには extractSentQuoteToken() を使うこと。
   */
  async pushMessage(
    to: string,
    messages: Message[],
    retryKey?: string,
    customAggregationUnits?: string[],
  ): Promise<PushMessageResponse> {
    const body: PushMessageRequest = { to, messages, customAggregationUnits };
    const { data } = await this.request(
      'POST',
      '/v2/bot/message/push',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return (data ?? {}) as PushMessageResponse;
  }

  async multicast(
    to: string[],
    messages: Message[],
    customAggregationUnits?: string[],
    retryKey?: string,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: Record<string, unknown> = { to, messages };
    if (customAggregationUnits) {
      body.customAggregationUnits = customAggregationUnits;
    }
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/multicast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-request-id') };
  }

  async broadcast(
    messages: Message[],
    retryKey?: string,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: BroadcastRequest = { messages };
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/broadcast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-request-id') };
  }

  async replyMessage(
    replyToken: string,
    messages: Message[],
  ): Promise<unknown> {
    const body: ReplyMessageRequest = { replyToken, messages };
    const { data } = await this.request('POST', '/v2/bot/message/reply', body);
    return data;
  }

  // ─── Rich Menu ────────────────────────────────────────────────────────────

  async getRichMenuList(): Promise<{ richmenus: RichMenuObject[] }> {
    const { data } = await this.request('GET', '/v2/bot/richmenu/list');
    return data as { richmenus: RichMenuObject[] };
  }

  async createRichMenu(menu: RichMenuObject): Promise<{ richMenuId: string }> {
    const { data } = await this.request('POST', '/v2/bot/richmenu', menu);
    return data as { richMenuId: string };
  }

  async deleteRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async setDefaultRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async linkRichMenuToUser(
    userId: string,
    richMenuId: string,
  ): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async unlinkRichMenuFromUser(userId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data;
  }

  async getRichMenuIdOfUser(userId: string): Promise<{ richMenuId: string }> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data as { richMenuId: string };
  }

  async getDefaultRichMenuId(): Promise<string | null> {
    const url = `${getLineApiBase()}/v2/bot/user/all/richmenu`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LineApiError(res.status, res.statusText, text);
    }
    const data = (await res.json()) as { richMenuId: string };
    return data.richMenuId;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * テキストを push 送信する。quoteToken を渡すと LINE 側で引用リプライになる。
   * 未指定のときは quoteToken キー自体を送らない (LINE API は undefined を嫌う)。
   */
  async pushTextMessage(to: string, text: string, quoteToken?: string): Promise<PushMessageResponse> {
    const message: TextMessage = { type: 'text', text };
    if (quoteToken) message.quoteToken = quoteToken;
    return this.pushMessage(to, [message]);
  }

  async pushFlexMessage(
    to: string,
    altText: string,
    contents: FlexContainer,
  ): Promise<PushMessageResponse> {
    return this.pushMessage(to, [{ type: 'flex', altText, contents }]);
  }

  async pushImageMessage(
    to: string,
    originalContentUrl: string,
    previewImageUrl: string,
  ): Promise<PushMessageResponse> {
    return this.pushMessage(to, [{ type: 'image', originalContentUrl, previewImageUrl }]);
  }

  // ─── Rich Menu Image Upload ─────────────────────────────────────────────

  /** Upload image to a rich menu. Accepts PNG/JPEG binary (ArrayBuffer or Uint8Array). */
  async uploadRichMenuImage(
    richMenuId: string,
    imageData: ArrayBuffer,
    contentType: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<void> {
    const url = `${getLineContentApiBase()}/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: imageData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LineApiError(res.status, res.statusText, text);
    }
  }

  // ─── Insight API ─────────────────────────────────────────────────────────

  /**
   * Get user interaction statistics for a broadcast message.
   * Data becomes available ~3 days after sending.
   * GET only — no messages are sent.
   */
  async getMessageEventInsight(requestId: string): Promise<unknown> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event?requestId=${encodeURIComponent(requestId)}`,
    );
    return data;
  }

  /**
   * Get statistics per unit for multicast messages.
   * GET only — no messages are sent.
   */
  async getUnitInsight(
    customAggregationUnit: string,
    from: string,
    to: string,
  ): Promise<unknown> {
    const params = new URLSearchParams({ customAggregationUnit, from, to });
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event/aggregation?${params.toString()}`,
    );
    return data;
  }

  /**
   * Get the number of followers for a LINE Official Account on a given date.
   * GET only — no messages are sent.
   */
  async getFollowersInsight(date: string): Promise<FollowersInsight> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/followers?date=${encodeURIComponent(date)}`,
    );
    return data as FollowersInsight;
  }

  /**
   * Get the monthly message quota of the LINE Official Account's plan.
   * GET only — no messages are sent.
   */
  async getMessageQuota(): Promise<MessageQuota> {
    const { data } = await this.request('GET', '/v2/bot/message/quota');
    return data as MessageQuota;
  }

  /**
   * Get the number of messages already counted against this month's quota.
   * GET only — no messages are sent.
   */
  async getMessageQuotaConsumption(): Promise<MessageQuotaConsumption> {
    const { data } = await this.request('GET', '/v2/bot/message/quota/consumption');
    return data as MessageQuotaConsumption;
  }

  /**
   * Get one page of users who currently follow the LINE Official Account.
   * Verified/premium accounts only. Pass the returned `next` value as
   * `start` until `next` is absent to retrieve the full audience.
   */
  async getFollowerIds(
    limit = 1000,
    start?: string,
  ): Promise<FollowerIdsPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (start) params.set('start', start);
    const { data } = await this.request(
      'GET',
      `/v2/bot/followers/ids?${params.toString()}`,
    );
    return data as FollowerIdsPage;
  }
}

/**
 * push / reply レスポンスから先頭メッセージの quoteToken を安全に取り出す。
 *
 * LINE は `{"sentMessages":[{"id":"...","quoteToken":"..."}]}` を返すが、
 * 409 (retry key 済み)・仕様変更・引用非対応のメッセージ種別では欠ける。
 * ここは「取れなければ null」に倒す — 送信自体は既に成功しているので、
 * トークンが取れないことを理由に例外を投げてはいけない (再送=二重送信の元)。
 */
export function extractSentQuoteToken(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const sent = (response as { sentMessages?: unknown }).sentMessages;
  if (!Array.isArray(sent) || sent.length === 0) return null;
  const first = sent[0];
  if (!first || typeof first !== 'object') return null;
  const token = (first as { quoteToken?: unknown }).quoteToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}
