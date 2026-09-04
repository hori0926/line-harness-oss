import { Hono } from 'hono';
import type { Env } from '../index.js';

const images = new Hono<Env>();

// POST /api/images — upload image (base64 or binary)
images.post('/api/images', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || '';

    let data: ArrayBuffer;
    let mimeType: string;
    let filename: string | undefined;

    if (contentType.includes('application/json')) {
      const body = await c.req.json<{
        data: string;
        mimeType?: string;
        filename?: string;
      }>();

      if (!body.data) {
        return c.json({ success: false, error: 'data (base64) is required' }, 400);
      }

      let base64 = body.data;
      if (base64.startsWith('data:')) {
        const match = base64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64 = match[2];
        }
      }
      mimeType ??= body.mimeType ?? 'image/png';
      filename = body.filename;

      const binary = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      data = binary.buffer;
    } else {
      data = await c.req.arrayBuffer();
      mimeType = contentType.split(';')[0] || 'image/png';
    }

    if (data.byteLength > 10 * 1024 * 1024) {
      return c.json({ success: false, error: 'Image too large (max 10MB)' }, 400);
    }

    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mimeType)) {
      return c.json({ success: false, error: `Unsupported image type: ${mimeType}. Allowed: ${allowedTypes.join(', ')}` }, 400);
    }

    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    const id = crypto.randomUUID();
    const key = `${id}.${ext}`;

    await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename ?? key },
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${workerUrl}/images/${key}`;

    return c.json({
      success: true,
      data: { id, key, url, mimeType, size: data.byteLength },
    }, 201);
  } catch (err) {
    console.error('POST /api/images error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * Range ヘッダを R2Range に変換する。単一レンジのみ対応 (マルチパートレンジは
 * 動画シークでは使われないので 200 で全体を返すことで足りる)。
 * 解釈できない場合は null を返し、呼び出し元は通常の 200 応答にフォールバックする。
 */
function parseRangeHeader(value: string | undefined): R2Range | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    return suffix > 0 ? { suffix } : null;
  }
  const start = Number(rawStart);
  if (rawEnd === '') return { offset: start };
  const end = Number(rawEnd);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/** R2 が解決したレンジ (無ければリクエスト側の指定) を [start, end] に落とす。 */
function resolveRange(range: R2Range, size: number): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if ('suffix' in range) {
    start = Math.max(0, size - range.suffix);
    end = size - 1;
  } else {
    start = range.offset ?? 0;
    end = range.length != null ? start + range.length - 1 : size - 1;
  }
  end = Math.min(end, size - 1);
  if (size === 0 || start >= size || end < start) return null;
  return { start, end };
}

/**
 * ダウンロード時のファイル名。日本語が化けないよう RFC 5987 の filename* を付け、
 * 併せて ASCII の filename= も出して古いクライアントに備える。
 */
/** customMetadata.downloadName は percent-encode して保存されている (incoming-media.ts 参照)。 */
function decodeDownloadName(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw;
  }
}

function contentDispositionAttachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  // encodeURIComponent は !'()* を残すが RFC 5987 の attr-char ではないので個別に潰す。
  const encoded = encodeURIComponent(name).replace(/['()!*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// GET /images/:key — serve image / video / audio / file (public, no auth)
images.get('/images/:key', async (c) => {
  const key = c.req.param('key');
  // Public route: only flat "{uuid}.{ext}" keys are servable. Anything with a
  // path separator (e.g. archive/ objects) must 404.
  if (key.includes('/') || key.includes('\\')) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }

  // 動画のシークバーには 206 Partial Content が要る。Range が無い場合は従来通り 200。
  const range = parseRangeHeader(c.req.header('Range'));

  let object: R2ObjectBody | null;
  try {
    object = await c.env.IMAGES.get(key, range ? { range } : undefined);
  } catch (err) {
    // 不正な Range を R2 が拒否した場合。サイズが分からないので */* で 416 を返す。
    console.error('GET /images/:key range get failed:', err);
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */*', 'Accept-Ranges': 'bytes' } });
  }

  if (!object) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.etag);
  headers.set('Accept-Ranges', 'bytes');

  // 受信ファイル (incoming-media が保存したもの) だけ元のファイル名で
  // ダウンロードさせる。画像/動画/音声には付けない (インライン再生が壊れるため)。
  const downloadName = decodeDownloadName(object.customMetadata?.downloadName);
  if (downloadName) {
    headers.set('Content-Disposition', contentDispositionAttachment(downloadName));
  }

  if (range) {
    const resolved = resolveRange(object.range ?? range, object.size);
    if (!resolved) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${object.size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    headers.set('Content-Range', `bytes ${resolved.start}-${resolved.end}/${object.size}`);
    headers.set('Content-Length', String(resolved.end - resolved.start + 1));
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
});

// DELETE /api/images/:key — delete image
images.delete('/api/images/:key', async (c) => {
  try {
    const key = c.req.param('key');
    await c.env.IMAGES.delete(key);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/images/:key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { images };
