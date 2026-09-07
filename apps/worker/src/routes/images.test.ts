import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { images } from './images.js';

type TestEnv = {
  Bindings: { DB: D1Database; IMAGES: R2Bucket };
};

type StubObject = { body: string; contentType?: string; customMetadata?: Record<string, string> };
type StubRange = { offset?: number; length?: number; suffix?: number };

function makeR2Stub() {
  const store = new Map<string, StubObject>();
  const r2 = {
    async put(
      key: string,
      value: string,
      options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
    ) {
      store.set(key, {
        body: String(value),
        contentType: options?.httpMetadata?.contentType,
        customMetadata: options?.customMetadata,
      });
      return {} as never;
    },
    // 本物の R2 と同じく、range 指定時も size は「オブジェクト全体」のサイズを返す。
    async get(key: string, options?: { range?: StubRange }) {
      const item = store.get(key);
      if (!item) return null;
      const size = item.body.length;
      let body = item.body;
      let range: StubRange | undefined;
      if (options?.range) {
        const r = options.range;
        let start: number;
        let end: number;
        if (r.suffix != null) {
          start = Math.max(0, size - r.suffix);
          end = size - 1;
        } else {
          start = r.offset ?? 0;
          end = r.length != null ? start + r.length - 1 : size - 1;
        }
        end = Math.min(end, size - 1);
        body = start > end ? '' : item.body.slice(start, end + 1);
        range = { offset: start, length: Math.max(0, end - start + 1) };
      }
      return {
        body,
        size,
        range,
        httpMetadata: { contentType: item.contentType },
        customMetadata: item.customMetadata,
        etag: 'test-etag',
      } as never;
    },
    async delete() {},
  } as unknown as R2Bucket;
  return { r2, store };
}

function setupApp() {
  const { r2, store } = makeR2Stub();
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database, IMAGES: r2 };
    await next();
  });
  app.route('/', images);
  return { app, store };
}

describe('GET /images/:key', () => {
  it('serves a flat key that exists', async () => {
    const { app, store } = setupApp();
    store.set('abc.png', { body: 'png-bytes', contentType: 'image/png' });
    const res = await app.request('/images/abc.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('404s for a missing key', async () => {
    const { app } = setupApp();
    const res = await app.request('/images/missing.png');
    expect(res.status).toBe(404);
  });

  it('never serves slash-containing keys (archive/ objects are not public)', async () => {
    const { app, store } = setupApp();
    store.set('archive/messages_log/2026-01-01/m1.ndjson', {
      body: 'secret',
      contentType: 'application/x-ndjson',
    });
    const res = await app.request('/images/archive%2Fmessages_log%2F2026-01-01%2Fm1.ndjson');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });
});

describe('GET /images/:key — 動画/音声/ファイル配信', () => {
  it('保存された Content-Type をそのまま返す (mp4)', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-1.mp4', { body: '0123456789', contentType: 'video/mp4' });
    const res = await app.request('/images/incoming-a-1.mp4');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    // Range に対応していることをクライアントに知らせる (シーク可否に直結)
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('Range リクエストに 206 Partial Content で応答する', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-2.mp4', { body: '0123456789', contentType: 'video/mp4' });
    const res = await app.request('/images/incoming-a-2.mp4', { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('末尾省略の Range (bytes=5-) も 206', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-3.mp4', { body: '0123456789', contentType: 'video/mp4' });
    const res = await app.request('/images/incoming-a-3.mp4', { headers: { Range: 'bytes=5-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 5-9/10');
    expect(await res.text()).toBe('56789');
  });

  it('suffix Range (bytes=-3) も 206', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-4.mp4', { body: '0123456789', contentType: 'video/mp4' });
    const res = await app.request('/images/incoming-a-4.mp4', { headers: { Range: 'bytes=-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await res.text()).toBe('789');
  });

  it('範囲外の Range は 416', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-5.mp4', { body: '0123456789', contentType: 'video/mp4' });
    const res = await app.request('/images/incoming-a-5.mp4', { headers: { Range: 'bytes=100-200' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('解釈できない Range は無視して 200 を返す', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-6.mp4', { body: '0123456789', contentType: 'video/mp4' });
    const res = await app.request('/images/incoming-a-6.mp4', { headers: { Range: 'items=0-1' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('0123456789');
  });

  it('downloadName があれば元のファイル名でダウンロードさせる (日本語)', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-7.pdf', {
      body: 'pdf-bytes',
      contentType: 'application/pdf',
      customMetadata: { downloadName: encodeURIComponent('見積書.pdf') },
    });
    const res = await app.request('/images/incoming-a-7.pdf');
    expect(res.status).toBe(200);
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('見積書.pdf')}`);
    // 非 ASCII を落とした素の filename= も併記され、引用符が壊れていないこと
    expect(disposition).toContain('filename="___.pdf"');
  });

  it("RFC 5987 の attr-char 外 (' など) もパーセントエンコードする", async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-8.pdf', {
      body: 'pdf-bytes',
      contentType: 'application/pdf',
      customMetadata: { downloadName: encodeURIComponent("o'brien (1).pdf") },
    });
    const res = await app.request('/images/incoming-a-8.pdf');
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain("filename*=UTF-8''o%27brien%20%281%29.pdf");
  });

  it('画像には Content-Disposition を付けない (インライン表示を壊さない)', async () => {
    const { app, store } = setupApp();
    store.set('incoming-a-9.jpg', { body: 'jpg-bytes', contentType: 'image/jpeg' });
    const res = await app.request('/images/incoming-a-9.jpg');
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });
});
