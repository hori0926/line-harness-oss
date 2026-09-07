/**
 * 引用リプライ（LINE の引用返信）まわりの純粋ロジック。
 *
 * page.tsx は 1400 行近くあり描画と状態が絡んでいてテストしづらいので、
 * 「引用できるか」「引用元をどう解決するか」「プレビューをどう省略するか」
 * だけをここに切り出してテスト可能にしている。
 */

export interface QuotableMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
  /** true ならこのメッセージを引用して返信できる (トークンの実値はサーバーから出さない) */
  quotable?: boolean
  /** このメッセージが引用した元メッセージの id */
  quotedMessageId?: string | null
}

/** プレビュー / バブル内引用ブロックに表示する最大文字数 */
export const QUOTE_EXCERPT_MAX_LENGTH = 60

/**
 * 引用元が messages 配列に見つからないときの表示。
 * 履歴は 1000 件で打ち切られるので、古い引用元は普通に落ちる。
 */
export const MISSING_QUOTE_LABEL = '引用元のメッセージ'

/** テキスト以外は本文を出しても意味がないので種別ラベルに置き換える (チャット一覧の preview と同じ流儀) */
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  image: '📷 画像',
  flex: '📋 Flexメッセージ',
  sticker: '🎨 スタンプ',
  video: '🎥 動画',
  audio: '🎤 音声',
  file: '📎 ファイル',
  location: '📍 位置情報',
}

/** 本文が空 (空白だけを含む) のテキストメッセージの表示 */
const EMPTY_TEXT_LABEL = '(本文なし)'

/**
 * このメッセージを引用できるか。
 * quotable が true のときだけ引用可。フィールドが来ない (サーバーが古い) 場合は
 * 引用不可に倒す — 引用できないメッセージを送るとサーバーが 400 を返すため。
 * direction は見ない: outgoing (自分の送信) も引用対象になり得る。
 */
export function canQuoteMessage(message: Pick<QuotableMessage, 'quotable'> | null | undefined): boolean {
  if (!message) return false
  return message.quotable === true
}

/**
 * 引用元メッセージを同じ messages 配列から id で探す。
 * 見つからなければ null (呼び出し側でフォールバック表示にする)。
 */
export function findQuotedMessage<T extends { id: string }>(
  messages: readonly T[] | null | undefined,
  quotedMessageId: string | null | undefined,
): T | null {
  if (!messages || !quotedMessageId) return null
  return messages.find((m) => m.id === quotedMessageId) ?? null
}

/**
 * 引用プレビュー用の抜粋。改行/連続空白は 1 スペースに潰し、長文は省略記号で切る。
 * テキスト以外は種別ラベルを返す。
 */
export function quoteExcerpt(
  message: Pick<QuotableMessage, 'messageType' | 'content'> | null | undefined,
  maxLength: number = QUOTE_EXCERPT_MAX_LENGTH,
): string {
  if (!message) return MISSING_QUOTE_LABEL

  const typeLabel = MESSAGE_TYPE_LABELS[message.messageType]
  if (typeLabel) return typeLabel

  const normalized = (message.content ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return EMPTY_TEXT_LABEL
  // maxLength が 0 以下でも「…」だけの意味不明な表示にはしない
  if (maxLength <= 0) return normalized
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}…`
}

/**
 * quotedMessageId から表示用の抜粋を解決する。
 * 配列に居ない (履歴の打ち切りなど) 場合は落とさずフォールバック文言を返す。
 */
export function resolveQuoteExcerpt(
  messages: readonly QuotableMessage[] | null | undefined,
  quotedMessageId: string | null | undefined,
  maxLength: number = QUOTE_EXCERPT_MAX_LENGTH,
): string {
  const quoted = findQuotedMessage(messages, quotedMessageId)
  if (!quoted) return MISSING_QUOTE_LABEL
  return quoteExcerpt(quoted, maxLength)
}

/**
 * 送信時に quotedMessageId を実際に付けてよいか。
 * - 引用対象が選ばれていない → 付けない
 * - 画像添付中 → 付けない (サーバーが text 以外の引用を 400 で弾くため)
 */
export function quotedMessageIdForSend(
  quotedMessageId: string | null | undefined,
  hasPendingImage: boolean,
): string | undefined {
  if (!quotedMessageId) return undefined
  if (hasPendingImage) return undefined
  return quotedMessageId
}
