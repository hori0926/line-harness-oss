/**
 * チャットの自動更新 (ポーリング) まわりの純粋ロジック。
 *
 * page.tsx は 1500 行超で描画と状態が絡み合っていてテストできないので、
 * 「差分をどうマージするか」「since に何を渡すか」「スクロールを追従させるか」
 * 「そもそもポーリングしてよいか」だけをここに切り出している
 * (quote-reply.ts と同じ流儀)。
 */

/** 選択中チャットの差分取得の間隔 */
export const DETAIL_POLL_INTERVAL_MS = 15_000

// チャット一覧には定期ポーリングを入れていない。
// 一覧クエリは last_any CTE が messages_log を全走査する構造で、本番実測
// 459ms / 165k rows_read (LIMIT 300)。30 秒間隔ならオペレーター 5 人で
// 1 日 8 億行に達し、D1 の無料枠 (500 万行/日) を 2 桁超過する。
// 選択中チャットの差分で新着を検知したら applyChatListRow でその 1 行だけ
// ローカル更新し、他の会話はサイドバーの未対応バッジ (5 分間隔) に任せる。

/**
 * 「最下部付近を見ている」とみなす下端からの距離 (px)。
 * 引用プレビューの出し入れで使っているしきい値と同じ値に揃えている。
 */
export const NEAR_BOTTOM_THRESHOLD_PX = 120

/**
 * 楽観更新したメッセージと、サーバーから返ってきた同じメッセージを
 * 同一とみなす時刻の許容幅。クライアント時計とサーバー時計のズレ +
 * 送信の往復時間を吸収できる程度に広めに取る。
 */
export const PENDING_MATCH_WINDOW_MS = 120_000

export interface SyncableMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  contentUpdatedAt?: string | null
  createdAt: string
  /**
   * 楽観更新でローカルに足しただけで、まだサーバーから返ってきていないメッセージ。
   * id はクライアント生成の UUID なのでサーバーの id とは一致しない。
   * - since の起点にしてはいけない (クライアント時計基準なので新着を取りこぼす)
   * - サーバー版が返ってきたら差し替える (id が違うので二重表示になるため)
   */
  pending?: boolean
}

function timeOf(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * 差分取得の `since` に渡す値。
 * サーバー由来のメッセージのうち最新の createdAt を返す。無ければ null
 * (呼び出し側は since なしの全件取得にフォールバックする)。
 *
 * 楽観更新分 (pending) を除外するのが要点:
 * pending の createdAt はクライアント時計なので、端末の時計が進んでいると
 * その間に届いた相手のメッセージを永久に取りこぼす。
 * 配列の末尾ではなく最大値を取るのも同じ理由 (時計ズレで順序が入れ替わり得る)。
 */
export function sinceForPoll(messages: readonly SyncableMessage[] | null | undefined): string | null {
  if (!messages || messages.length === 0) return null
  let latest: string | null = null
  for (const m of messages) {
    if (m.pending) continue
    if (!m.createdAt) continue
    const cursor = m.contentUpdatedAt ?? m.createdAt
    if (latest === null || timeOf(cursor) > timeOf(latest)) latest = cursor
  }
  return latest
}

/**
 * 楽観更新したメッセージ (pending) が、サーバーから返ってきたメッセージと
 * 同一のものかを判定する。id はクライアント生成なので突き合わせに使えない。
 */
function isSameAsPending(pendingMsg: SyncableMessage, serverMsg: SyncableMessage): boolean {
  if (!pendingMsg.pending) return false
  if (serverMsg.pending) return false
  if (pendingMsg.direction !== 'outgoing' || serverMsg.direction !== 'outgoing') return false
  if (pendingMsg.messageType !== serverMsg.messageType) return false
  if (pendingMsg.content !== serverMsg.content) return false
  return Math.abs(timeOf(serverMsg.createdAt) - timeOf(pendingMsg.createdAt)) <= PENDING_MATCH_WINDOW_MS
}

/**
 * ポーリング結果を既存の messages 配列にマージする。
 *
 * - `isDelta: true`  … incoming は差分。既存配列に足す
 * - `isDelta: false` … incoming は全件。既存配列を置き換える
 *   (ただしサーバーがまだ知らない楽観更新分は残す — 送ったメッセージが
 *    一瞬消えるのを防ぐ)
 *
 * どちらの場合も
 * - id が重複したらサーバー側 (incoming) を採用する
 * - 楽観更新分は、対応するサーバー版が来ていたら捨てる (id が違うので
 *   id の重複除去だけでは二重表示が残る)
 * - createdAt の昇順に整える (日付セパレータが順序に依存しているため)
 */
export function mergeMessages<T extends SyncableMessage>(
  existing: readonly T[] | null | undefined,
  incoming: readonly T[] | null | undefined,
  options: { isDelta: boolean },
): T[] {
  const base = existing ?? []
  const next = incoming ?? []
  // 全件取得なら既存はサーバー版で総入れ替え。残すのは未確認の楽観更新分だけ。
  const kept = options.isDelta ? base : base.filter((m) => m.pending === true)

  const incomingIds = new Set(next.map((m) => m.id))
  const survivors = kept.filter((m) => {
    if (incomingIds.has(m.id)) return false
    if (m.pending && next.some((s) => isSameAsPending(m, s))) return false
    return true
  })

  // Array#sort は安定なので、createdAt が同値なら既存 → 新着の順が保たれる
  return [...survivors, ...next].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))
}

/**
 * 新着メッセージが増えたか (「新着メッセージ ↓」の導線を出すかの判定に使う)。
 * 自分が送ったメッセージがサーバー版に差し替わっただけのときは増えない。
 */
export function countNewMessages(
  before: readonly SyncableMessage[] | null | undefined,
  after: readonly SyncableMessage[] | null | undefined,
): number {
  const beforeIds = new Set((before ?? []).map((m) => m.id))
  return (after ?? []).filter((m) => !beforeIds.has(m.id)).length
}

/**
 * メッセージが増えたときにスクロールを最下部へ追従させるか。
 * 距離は「メッセージが増える前」に測った値を渡すこと — 増えた後に測ると
 * 追加分の高さで必ずしきい値を超え、最下部にいたのに追従しなくなる。
 */
export function shouldFollowScroll(
  distanceFromBottom: number,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  if (!Number.isFinite(distanceFromBottom)) return true
  return distanceFromBottom <= threshold
}

export interface DetailPollGate {
  /** document.visibilityState === 'hidden' */
  documentHidden: boolean
  /** 送信中。楽観更新と競合して送ったメッセージが一瞬消えるのでポーリングしない */
  sending: boolean
  /** 開いているチャットがあるか */
  hasSelectedChat: boolean
  /** 直前のポーリング / 初回ロードがまだ飛んでいる */
  requestInFlight: boolean
}

/** 選択中チャットの差分取得を実行してよいか */
export function shouldPollChatDetail(gate: DetailPollGate): boolean {
  if (!gate.hasSelectedChat) return false
  if (gate.documentHidden) return false
  if (gate.sending) return false
  if (gate.requestInFlight) return false
  return true
}

export interface ChatListRowPatch {
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  status?: 'unread' | 'in_progress' | 'resolved'
}

/**
 * 差分ポーリングで新着を見つけたとき、その会話の一覧行だけをローカルで更新する。
 *
 * 一覧の再取得はしない — 一覧クエリは 1 回で 16 万行以上読むので、定期的に
 * 叩くと D1 の 1 日あたりの読み取り上限を桁違いに超える。
 *
 * - 一覧に居ない会話 (フィルタで除外中 / ディープリンク) には行を生やさない。
 *   勝手に増やすと「未読タブなのに対応中が出る」ような歪みになる。
 * - 送信直後の楽観更新と同じく、最終メッセージ時刻の降順に並べ直す。
 */
export function applyChatListRow<T extends { id: string; lastMessageAt: string | null }>(
  chats: readonly T[] | null | undefined,
  chatId: string,
  patch: ChatListRowPatch,
): T[] {
  const prev = chats ?? []
  if (!prev.some((c) => c.id === chatId)) return prev as T[]
  const updated = prev.map((c) => (c.id === chatId ? { ...c, ...patch } : c))
  return [...updated].sort((a, b) => timeOf(b.lastMessageAt ?? '') - timeOf(a.lastMessageAt ?? ''))
}
