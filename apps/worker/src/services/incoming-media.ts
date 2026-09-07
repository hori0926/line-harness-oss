import type {
  IncomingAudioContent,
  IncomingFileContent,
  IncomingMediaContent,
  IncomingVideoContent,
} from '@line-crm/shared';
import { getLineContentApiBase } from '@line-crm/line-sdk';

/**
 * LINE Content API (受信メディアのバイナリ取得) のベース。
 *
 * 実体は line-sdk 側の getLineContentApiBase() — 既定は
 * `https://api-data.line.me` で、環境変数 LINE_CONTENT_API_BASE_URL が
 * 設定されているときだけローカル開発用のモックサーバーに向く。
 *
 * ⚠️ 警告: 上書きは **ローカル開発専用**。実際の顧客が使うアカウントを扱う
 * 環境で設定すると、チャネルアクセストークンと、顧客が送ってきた画像・動画・
 * 音声・PDF の中身がそのまま指定ホストへ送られる (= 第三者への情報流出経路)。
 * 詳細は packages/line-sdk/src/client.ts 冒頭の警告を参照。
 */
function lineContentApiMessageBase(): string {
  return `${getLineContentApiBase()}/v2/bot/message`;
}

export type IncomingMediaKind = 'image' | 'video' | 'audio' | 'file';

/**
 * 受信メディアの保存サイズ上限 (バイト)。
 *
 * LINE は動画・音声を最大 200MB まで受け付けるが、Cloudflare Workers の
 * メモリ上限は 128MB。R2 への保存は ReadableStream をそのまま put する
 * ストリーミングで行い arrayBuffer() を経由しないので、理屈の上では全体を
 * メモリに載せない。それでもハードキャップを置くのは、
 *   - ランタイム側のバッファリングや将来の実装変更で 128MB に近づく事故を防ぐ
 *   - 巨大ファイルを R2 に貯め続けるストレージコストを抑える
 * ためで、上限超過時は「保存せずラベル表示にフォールバック」する (本文は失われるが
 * webhook は正常終了する) のが、OOM で webhook ごと落ちるより明確に良い。
 *
 * 値の根拠 (業務上確認したいサイズ × 安全側):
 *   image 10MB — 既存の POST /api/images の上限と同値。LINE の画像も実質この範囲。
 *   video 50MB — スマホ実写でおよそ 1 分前後。これを超える尺を管理画面で確認する
 *                実務ニーズは薄く、LINE 上限の 200MB は明確に拒否したい。
 *   audio 20MB — m4a なら 1 時間以上。ボイスメッセージには十分すぎる。
 *   file  20MB — 見積書・図面 PDF の実務レンジ。
 */
export const MAX_INCOMING_MEDIA_BYTES: Record<IncomingMediaKind, number> = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  file: 20 * 1024 * 1024,
};

/** 動画サムネイル (LINE Content API の preview) の上限。実体はサムネイル JPEG なので小さくてよい。 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

/**
 * file の Content-Type が application/octet-stream で返ってきたときに、
 * 元ファイル名の拡張子から実用的な Content-Type を復元するための表。
 * 「PDF がブラウザで開けない」を防ぐのが主目的。
 */
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** kind ごとの既定値 (Content-Type が取れない/汎用すぎるときのフォールバック)。 */
const KIND_DEFAULTS: Record<IncomingMediaKind, { ext: string; contentType: string }> = {
  image: { ext: 'jpg', contentType: 'image/jpeg' },
  video: { ext: 'mp4', contentType: 'video/mp4' },
  audio: { ext: 'm4a', contentType: 'audio/mp4' },
  file: { ext: 'bin', contentType: 'application/octet-stream' },
};

/**
 * ブラウザがスクリプトとして実行し得る Content-Type は保存しない。
 * /images/:key は認証なしの公開ルートなので、利用者が送ってきた HTML/SVG を
 * worker オリジンで inline 表示すると保存型 XSS になる。octet-stream に落とす。
 */
const SCRIPTABLE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'application/javascript',
  'text/javascript',
]);

export interface FetchAndStoreIncomingMediaOptions {
  r2: R2Bucket;
  /** workers 環境では globalThis.fetch を使う。テスト時に注入する。 */
  fetch?: typeof fetch;
  /** 公開 URL のベース (例: https://your-worker.your-subdomain.workers.dev) */
  workerUrl: string;
  channelAccessToken: string;
  accountId: string;
  messageId: string;
  kind: IncomingMediaKind;
  /** audio: 再生時間 (ミリ秒)。webhook イベント由来。 */
  duration?: number;
  /** file: 元のファイル名。webhook イベント由来。 */
  fileName?: string;
  /** file: バイト数。webhook イベント由来。 */
  fileSize?: number;
}

export interface IncomingImageRefs {
  originalContentUrl: string;
  previewImageUrl: string;
}

interface StoredObject {
  url: string;
  key: string;
}

function normalizeContentType(raw: string | null): string | null {
  const value = raw?.split(';')[0].trim().toLowerCase();
  return value ? value : null;
}

function sanitizeExt(ext: string | undefined): string | null {
  if (!ext) return null;
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  // 拡張子はそのまま R2 キーの末尾になる。/images/:key は「フラットな
  // {name}.{ext} のみ配信可」なので、記号を落として長さも抑える。
  if (!cleaned || cleaned.length > 10) return null;
  return cleaned;
}

function extFromFileName(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return null;
  return sanitizeExt(fileName.slice(dot + 1));
}

/** Upload fixed-size parts so R2 never receives an unknown-length stream.
 * At most one 5 MiB part is buffered, independent of the incoming file size. */
export async function putBoundedMedia(
  r2: R2Bucket, key: string, body: ReadableStream<Uint8Array>,
  limit: number, metadata: R2HTTPMetadata, customMetadata?: Record<string, string>,
): Promise<void> {
  const partSize = 5 * 1024 * 1024;
  const reader = body.getReader();
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(partSize);
  let used = 0;
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('incoming-media: size limit exceeded');
      let offset = 0;
      while (offset < value.byteLength) {
        const size = Math.min(partSize - used, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + size), used);
        used += size;
        offset += size;
        if (used === partSize) {
          upload ??= await r2.createMultipartUpload(key, { httpMetadata: metadata, customMetadata });
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(partSize);
          used = 0;
        }
      }
    }
    if (!upload) {
      await r2.put(key, buffer.subarray(0, used), { httpMetadata: metadata, customMetadata });
    } else {
      if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
      await upload.complete(parts);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    await upload?.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchLineContent(
  opts: FetchAndStoreIncomingMediaOptions,
  path: string,
): Promise<Response | null> {
  const fetcher = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetcher(`${lineContentApiMessageBase()}/${opts.messageId}/${path}`, {
      headers: { Authorization: `Bearer ${opts.channelAccessToken}` },
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    console.error('incoming-media: fetch failed', { err, path, messageId: opts.messageId, accountId: opts.accountId });
    return null;
  }
  // Get content の成功は 200 のみ。大きい動画/音声の準備中は LINE が 202 を返すが、
  // その body はメディア本体ではないので R2 に保存してはいけない。
  // 202 の再試行は durable queue 化と合わせて行う (現状はラベルへフォールバック)。
  if (res.status !== 200) {
    console.error('incoming-media: non-200', { status: res.status, path, messageId: opts.messageId, accountId: opts.accountId });
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return res;
}

/** Content-Length を見て上限超過なら true。ヘッダが無い/数値でないなら false (ストリーム側で打ち切る)。 */
function exceedsDeclaredLength(res: Response, limit: number): boolean {
  const header = res.headers.get('Content-Length');
  if (header === null) return false;
  const declared = Number(header);
  if (!Number.isFinite(declared)) return false;
  return declared > limit;
}

async function storeFromResponse(
  opts: FetchAndStoreIncomingMediaOptions,
  res: Response,
  params: {
    key: string;
    contentType: string;
    limit: number;
    /** 指定すると Content-Disposition: attachment のダウンロード名として保存する。 */
    downloadName?: string;
  },
): Promise<StoredObject | null> {
  if (exceedsDeclaredLength(res, params.limit)) {
    console.error('incoming-media: too large (Content-Length)', {
      contentLength: res.headers.get('Content-Length'),
      limit: params.limit,
      messageId: opts.messageId,
      accountId: opts.accountId,
    });
    // 本文は読まずに捨てる。ここで arrayBuffer() すると上限を設けた意味が無い。
    void res.body?.cancel().catch(() => {});
    return null;
  }

  if (!res.body) {
    console.error('incoming-media: empty body', { messageId: opts.messageId, accountId: opts.accountId });
    return null;
  }

  try {
    await putBoundedMedia(opts.r2, params.key, res.body, params.limit,
      { contentType: params.contentType },
      params.downloadName ? { downloadName: encodeURIComponent(params.downloadName) } : undefined,
    );
  } catch (err) {
    console.error('incoming-media: R2 put failed', { err, key: params.key, messageId: opts.messageId, accountId: opts.accountId });
    // 上限超過で打ち切った場合など、途中まで書かれたオブジェクトが残り得るので消す。
    try {
      await opts.r2.delete(params.key);
    } catch {
      // best-effort。消せなくてもフォールバックの妨げにはしない。
    }
    return null;
  }

  const base = opts.workerUrl.replace(/\/$/, '');
  return { key: params.key, url: `${base}/images/${params.key}` };
}

/**
 * R2 キーに混ぜる推測不能なトークン。1 メッセージにつき 1 個生成し、
 * 動画本体とそのサムネイル (suffix 付き) で共有する。
 */
function newKeyToken(): string {
  return crypto.randomUUID();
}

/**
 * R2 オブジェクトキーを組み立てる。
 *
 * GET /images/:key は認証なしの公開ルートなので、キー自体が capability URL として
 * 機能する。accountId + messageId だけだと:
 *   - 単一アカウント構成では accountId が 'unknown' 固定になり秘密として働かない
 *   - LINE の messageId は時刻ベースの Snowflake 風 ID で、同時期のメッセージは
 *     近い値になる = 1 件知っていれば周辺を総当たりできる
 * ため、他人の見積書・契約書・身分証が引けてしまう。ランダムな UUID を混ぜて
 * 推測不能にする (accountId / messageId は運用時の追跡用に残す)。
 *
 * 既存の保存済みオブジェクトには影響しない。GET /images/:key は受け取ったキーを
 * そのまま R2 に問い合わせるだけでキー形式を検証していないため、UUID 無しの
 * 旧キーも従来どおり配信される。
 */
function buildKey(
  opts: FetchAndStoreIncomingMediaOptions,
  ext: string,
  keyToken: string,
  suffix = '',
): string {
  // accountId / messageId は実質 UUID / LINE 数字 ID で安全だが、念のため
  // R2 キーに不正な文字（スラッシュ等）が混入しないよう sanitize する。
  const safeAccountId = opts.accountId.replace(/[^a-zA-Z0-9-]/g, '_');
  const safeMessageId = opts.messageId.replace(/[^a-zA-Z0-9-]/g, '_');
  const safeToken = keyToken.replace(/[^a-zA-Z0-9-]/g, '_');
  return `incoming-${safeAccountId}-${safeMessageId}-${safeToken}${suffix}.${ext}`;
}

function resolveTypeAndExt(
  opts: FetchAndStoreIncomingMediaOptions,
  res: Response,
): { contentType: string; ext: string } | null {
  const defaults = KIND_DEFAULTS[opts.kind];
  const raw = normalizeContentType(res.headers.get('Content-Type'));

  if (opts.kind === 'image') {
    // 既存挙動の維持: 画像は既知の image/* 以外を保存しない (回帰防止)。
    const ext = raw ? CONTENT_TYPE_TO_EXT[raw] : undefined;
    if (!raw || !ext || !raw.startsWith('image/')) {
      console.error('incoming-media: unsupported content-type', { contentType: raw, messageId: opts.messageId, accountId: opts.accountId });
      return null;
    }
    return { contentType: raw, ext };
  }

  // file は元ファイル名の拡張子を最優先する (LINE は octet-stream で返すことが多い)。
  const nameExt = opts.kind === 'file' ? extFromFileName(opts.fileName) : null;
  const generic = !raw || raw === 'application/octet-stream' || raw === 'binary/octet-stream';

  let contentType = generic
    ? (nameExt && EXT_TO_CONTENT_TYPE[nameExt]) || defaults.contentType
    : raw;
  if (SCRIPTABLE_CONTENT_TYPES.has(contentType)) contentType = 'application/octet-stream';

  const ext =
    nameExt ??
    (raw ? CONTENT_TYPE_TO_EXT[raw] : undefined) ??
    (contentType ? CONTENT_TYPE_TO_EXT[contentType] : undefined) ??
    defaults.ext;

  return { contentType, ext: sanitizeExt(ext) ?? defaults.ext };
}

/**
 * 動画のサムネイル。LINE Content API の /content/preview を試す。
 * 取れなければ null を返し、呼び出し元は originalContentUrl を poster に流用する。
 */
async function storeVideoPreview(
  opts: FetchAndStoreIncomingMediaOptions,
  keyToken: string,
): Promise<StoredObject | null> {
  const res = await fetchLineContent(opts, 'content/preview');
  if (!res) return null;
  const raw = normalizeContentType(res.headers.get('Content-Type'));
  const ext = (raw && CONTENT_TYPE_TO_EXT[raw]) ?? 'jpg';
  if (raw && !raw.startsWith('image/')) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  return storeFromResponse(opts, res, {
    // 本体と同じ keyToken を使う。別々に生成すると本体キーからサムネイルキーを
    // 導けなくなり、suffix による対応関係が壊れる。
    key: buildKey(opts, ext, keyToken, '-preview'),
    contentType: raw ?? 'image/jpeg',
    limit: MAX_PREVIEW_BYTES,
  });
}

/**
 * LINE Content API から受信メディアのバイナリを取得し、R2 に保存して
 * messages_log.content に入れる JSON を返す。
 *
 * 失敗時 (取得失敗 / 上限超過 / R2 失敗) は null を返し、呼び出し元は
 * `[動画]` 等のラベル文字列フォールバックをそのまま使う。例外は投げない。
 */
export async function fetchAndStoreIncomingMedia(
  opts: FetchAndStoreIncomingMediaOptions,
): Promise<IncomingMediaContent | null> {
  if (opts.kind === 'image') return null;

  const res = await fetchLineContent(opts, 'content');
  if (!res) return null;

  const resolved = resolveTypeAndExt(opts, res);
  if (!resolved) {
    void res.body?.cancel().catch(() => {});
    return null;
  }

  // 本体とサムネイルで共有するトークン。ここで 1 回だけ生成する。
  const keyToken = newKeyToken();

  const stored = await storeFromResponse(opts, res, {
    key: buildKey(opts, resolved.ext, keyToken),
    contentType: resolved.contentType,
    limit: MAX_INCOMING_MEDIA_BYTES[opts.kind],
    // file だけダウンロード名を持たせる。画像/動画/音声に Content-Disposition を
    // 付けると <img>/<video> のインライン再生が壊れるため付けない。
    downloadName: opts.kind === 'file' ? opts.fileName : undefined,
  });
  if (!stored) return null;

  if (opts.kind === 'video') {
    const preview = await storeVideoPreview(opts, keyToken);
    const content: IncomingVideoContent = {
      type: 'video',
      originalContentUrl: stored.url,
      previewImageUrl: preview?.url ?? stored.url,
    };
    return content;
  }

  if (opts.kind === 'audio') {
    const duration = typeof opts.duration === 'number' && Number.isFinite(opts.duration) ? opts.duration : undefined;
    const content: IncomingAudioContent = {
      type: 'audio',
      originalContentUrl: stored.url,
      ...(duration !== undefined ? { duration } : {}),
    };
    return content;
  }

  const fileSize = typeof opts.fileSize === 'number' && Number.isFinite(opts.fileSize) ? opts.fileSize : undefined;
  const content: IncomingFileContent = {
    type: 'file',
    url: stored.url,
    ...(opts.fileName ? { fileName: opts.fileName } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
  };
  return content;
}

/**
 * 受信画像用。既存呼び出し元との互換のため戻り値の形 (type 無しの
 * {originalContentUrl, previewImageUrl}) を維持している。
 */
export async function fetchAndStoreIncomingImageInternal(
  opts: Omit<FetchAndStoreIncomingMediaOptions, 'kind'>,
): Promise<IncomingImageRefs | null> {
  const withKind: FetchAndStoreIncomingMediaOptions = { ...opts, kind: 'image' };
  const res = await fetchLineContent(withKind, 'content');
  if (!res) return null;

  const resolved = resolveTypeAndExt(withKind, res);
  if (!resolved) {
    void res.body?.cancel().catch(() => {});
    return null;
  }

  const stored = await storeFromResponse(withKind, res, {
    key: buildKey(withKind, resolved.ext, newKeyToken()),
    contentType: resolved.contentType,
    limit: MAX_INCOMING_MEDIA_BYTES.image,
  });
  if (!stored) return null;

  return { originalContentUrl: stored.url, previewImageUrl: stored.url };
}
