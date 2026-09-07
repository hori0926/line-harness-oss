/**
 * 受信メディア (動画 / 音声 / ファイル) の content 解釈まわりの純粋ロジック。
 *
 * page.tsx は 1700 行超で描画と状態が絡み合っていてテストできないので、
 * 「content をどう解釈するか」「壊れていたら何を出すか」「秒数/バイト数を
 * どう見せるか」だけをここに切り出している (quote-reply.ts / message-sync.ts
 * と同じ流儀)。
 *
 * 前提 — messages_log.content は messageType が video/audio/file でも
 * JSON とは限らない:
 * - R2 保存に成功した新しいメッセージ … LINE の messaging API と同じ形の JSON
 * - 保存に失敗した / マイグレーション以前の古いメッセージ
 *   … `[動画]` `[ファイル: 見積書.pdf]` のような素のラベル文字列
 * 後者は「いつか消えるデータ」ではなく確実に残り続けるので、
 * JSON.parse の失敗で描画が落ちないことがこのモジュールの一番の役目。
 */

/** 種別だけが分かっているときの表示。サイドバーの preview / 引用抜粋と同じ文言に揃える */
const MEDIA_TYPE_LABELS: Record<string, string> = {
  video: '🎥 動画',
  audio: '🎤 音声',
  file: '📎 ファイル',
}

/** ファイル名が取れないときの表示 */
export const UNKNOWN_FILE_NAME = 'ファイル'

/** このモジュールが描画対象にする messageType */
export function isMediaMessageType(messageType: string): boolean {
  return messageType === 'video' || messageType === 'audio' || messageType === 'file'
}

export type MediaContent =
  | { kind: 'video'; url: string; posterUrl: string | null }
  | { kind: 'audio'; url: string; durationLabel: string | null }
  | {
      kind: 'file'
      url: string
      fileName: string
      sizeLabel: string | null
      /** 大文字の拡張子 (例: 'PDF')。取れなければ null */
      extension: string | null
    }
  /** JSON でない / URL が欠けている → 従来どおりラベル文字列を出す */
  | { kind: 'fallback'; label: string }

/**
 * media URL として受け入れてよいか。
 * href / src にそのまま入るので http(s) 以外 (javascript: 等) は弾く。
 * R2 の公開 URL は必ず https なので実データが弾かれることはない。
 */
function isUsableUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.startsWith('https://') || trimmed.startsWith('http://')
}

function usableUrlOrNull(value: unknown): string | null {
  return isUsableUrl(value) ? value.trim() : null
}

/**
 * content を JSON オブジェクトとして読む。読めなければ null。
 * 配列・数値・文字列などオブジェクト以外も null に倒す
 * (この契約で来るのは常にオブジェクト)。
 */
function parseJsonObject(content: string | null | undefined): Record<string, unknown> | null {
  const raw = (content ?? '').trim()
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * プレイヤーを出せないときの表示文字列。
 * - 素のラベル文字列 (`[動画]` 等) が入っていればそれをそのまま出す
 * - 空 / JSON として読めてしまう (= URL 欠落の壊れた JSON) 場合は種別ラベル
 *   生の JSON を吹き出しに出しても利用者には意味がないため。
 */
export function mediaFallbackLabel(messageType: string, content: string | null | undefined): string {
  const typeLabel = MEDIA_TYPE_LABELS[messageType] ?? `[${messageType}]`
  const raw = (content ?? '').trim()
  if (!raw) return typeLabel
  try {
    JSON.parse(raw)
    // JSON として読める = システムが生成した構造データ。人が読む文字列ではない
    return typeLabel
  } catch {
    // `[動画]` `[ファイル: 見積書.pdf]` のような従来のラベル。そのまま出す
    return raw
  }
}

/**
 * ミリ秒を「0:12」「1:02:03」形式にする。
 * duration は無いことがあるので、数値として読めないものは null
 * (呼び出し側は長さの併記を省く)。
 */
export function formatDuration(durationMs: unknown): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null
  const totalSeconds = Math.floor(durationMs / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/**
 * バイト数を「1.2 MB」形式にする。読めない値は null。
 * 1024 進数 (B だけ整数、KB 以上は小数第 1 位)。
 */
export function formatFileSize(bytes: unknown): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  let value = bytes
  let unitIndex = 0
  // 最大単位で頭打ちにする (異常に大きい値でも配列外にしない)
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unitIndex]}`
}

/**
 * 表示用の拡張子 (大文字)。fileName になければ URL の末尾から拾う。
 * 中身が想像できない PDF/ZIP 等でアイコン代わりに出す。
 */
export function fileExtensionLabel(fileName: string | null | undefined, url?: string | null): string | null {
  const candidates = [fileName, url]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    // URL のクエリ / フラグメントは拡張子ではない
    const path = candidate.split(/[?#]/)[0]
    const base = path.split('/').pop() ?? ''
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(base)
    if (match) return match[1].toUpperCase()
  }
  return null
}

/** URL の末尾からファイル名を推測する (fileName が来なかったとき用) */
function fileNameFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0]
  const base = path.split('/').pop() ?? ''
  if (!base) return null
  try {
    return decodeURIComponent(base)
  } catch {
    // 不正な %xx が混じっていてもここで落とさない
    return base
  }
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * messageType と content から描画方法を決める。
 * プレイヤーを出せない場合は必ず kind: 'fallback' を返すので、
 * 呼び出し側は例外を気にしなくてよい。
 */
export function resolveMediaContent(messageType: string, content: string | null | undefined): MediaContent {
  const fallback = (): MediaContent => ({ kind: 'fallback', label: mediaFallbackLabel(messageType, content) })
  if (!isMediaMessageType(messageType)) return fallback()

  const parsed = parseJsonObject(content)
  if (!parsed) return fallback()

  if (messageType === 'video') {
    const url = usableUrlOrNull(parsed.originalContentUrl)
    if (!url) return fallback()
    return { kind: 'video', url, posterUrl: usableUrlOrNull(parsed.previewImageUrl) }
  }

  if (messageType === 'audio') {
    const url = usableUrlOrNull(parsed.originalContentUrl)
    if (!url) return fallback()
    return { kind: 'audio', url, durationLabel: formatDuration(parsed.duration) }
  }

  // file: url が本体。fileName / fileSize は無いことがある
  const url = usableUrlOrNull(parsed.url)
  if (!url) return fallback()
  const fileName = nonEmptyString(parsed.fileName) ?? fileNameFromUrl(url) ?? UNKNOWN_FILE_NAME
  return {
    kind: 'file',
    url,
    fileName,
    sizeLabel: formatFileSize(parsed.fileSize),
    extension: fileExtensionLabel(fileName, url),
  }
}
