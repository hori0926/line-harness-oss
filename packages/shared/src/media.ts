/**
 * 受信メディア (動画/音声/ファイル) の messages_log.content JSON。
 *
 * 受信画像は歴史的に `{originalContentUrl, previewImageUrl}` (type フィールド無し)
 * で保存されており、既存行との互換のためその形は変更していない。
 * ここで定義するのは新規に対応する video / audio / file の 3 種。
 * sticker.ts と同じく「content に JSON を入れ、parse ヘルパーを shared に置く」流儀に揃えている。
 */

export interface IncomingVideoContent {
  type: 'video';
  originalContentUrl: string;
  /** <video poster> 用。Content API がサムネイルを返さない場合は originalContentUrl と同値。 */
  previewImageUrl: string;
}

export interface IncomingAudioContent {
  type: 'audio';
  originalContentUrl: string;
  /** ミリ秒。webhook イベントに含まれない場合は省略される。 */
  duration?: number;
}

export interface IncomingFileContent {
  type: 'file';
  url: string;
  /** 元のファイル名。webhook イベントに含まれない場合は省略される。 */
  fileName?: string;
  /** バイト数。webhook イベントに含まれない場合は省略される。 */
  fileSize?: number;
}

export type IncomingMediaContent =
  | IncomingVideoContent
  | IncomingAudioContent
  | IncomingFileContent;

const INCOMING_MEDIA_FALLBACKS: Record<IncomingMediaContent['type'], string> = {
  video: '[動画]',
  audio: '[音声]',
  file: '[ファイル]',
};

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * content 文字列を受信メディア JSON として解釈する。
 * ラベル文字列 (`[動画]` 等) や壊れた JSON なら null を返す。
 */
export function parseIncomingMediaContent(
  content: string | null | undefined,
): IncomingMediaContent | null {
  if (!content) return null;
  // ラベルフォールバックは `[` 始まり。JSON.parse を試す前に弾いて無駄な例外を避ける。
  if (!content.trimStart().startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'video') {
    const originalContentUrl = toNonEmptyString(obj.originalContentUrl);
    if (!originalContentUrl) return null;
    return {
      type: 'video',
      originalContentUrl,
      previewImageUrl: toNonEmptyString(obj.previewImageUrl) ?? originalContentUrl,
    };
  }
  if (obj.type === 'audio') {
    const originalContentUrl = toNonEmptyString(obj.originalContentUrl);
    if (!originalContentUrl) return null;
    const duration = toFiniteNumber(obj.duration);
    return {
      type: 'audio',
      originalContentUrl,
      ...(duration !== undefined ? { duration } : {}),
    };
  }
  if (obj.type === 'file') {
    const url = toNonEmptyString(obj.url);
    if (!url) return null;
    const fileName = toNonEmptyString(obj.fileName);
    const fileSize = toFiniteNumber(obj.fileSize);
    return {
      type: 'file',
      url,
      ...(fileName ? { fileName } : {}),
      ...(fileSize !== undefined ? { fileSize } : {}),
    };
  }
  return null;
}

/**
 * 受信メディアの表示ラベル。保存に失敗した行 (ラベル文字列そのまま) と
 * JSON 行の両方を同じ関数で扱えるようにしておく。
 */
export function incomingMediaFallback(
  messageType: string,
  content?: string | null,
): string {
  const parsed = parseIncomingMediaContent(content);
  if (parsed?.type === 'file' && parsed.fileName) {
    return `[ファイル: ${parsed.fileName}]`;
  }
  if (content && !parsed && content.trimStart().startsWith('[')) return content;
  return INCOMING_MEDIA_FALLBACKS[messageType as IncomingMediaContent['type']] ?? `[${messageType}]`;
}
