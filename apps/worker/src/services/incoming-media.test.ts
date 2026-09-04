import { describe, test, expect, vi } from 'vitest';
import { fetchAndStoreIncomingMedia, MAX_INCOMING_MEDIA_BYTES } from './incoming-media.js';

interface PutCall {
  key: string;
  value: unknown;
  opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
}

/**
 * R2 スタブ。put に渡された値がストリームなら実際に読み切る。
 * 上限超過で TransformStream が error になったケースを put の reject として
 * 観測できるようにするため、ここでの「読み切り」が要る。
 */
function makeR2Stub() {
  const puts: PutCall[] = [];
  const deleted: string[] = [];
  const r2 = {
    put: vi.fn(async (key: string, value: unknown, opts: PutCall['opts'] = {}) => {
      puts.push({ key, value, opts });
      if (value instanceof ReadableStream) {
        const reader = (value as ReadableStream<Uint8Array>).getReader();
        let total = 0;
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          total += chunk.byteLength;
        }
        return { key, size: total } as never;
      }
      return { key } as never;
    }),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
    }),
  };
  return { r2, puts, deleted };
}

function baseOpts(r2: ReturnType<typeof makeR2Stub>['r2'], fetchMock: typeof fetch) {
  return {
    r2: r2 as unknown as R2Bucket,
    fetch: fetchMock,
    workerUrl: 'https://worker.example.com',
    channelAccessToken: 'token-abc',
    accountId: 'acc-1',
  };
}

function okResponse(body: BodyInit | null, contentType: string, contentLength?: number) {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (contentLength !== undefined) headers['Content-Length'] = String(contentLength);
  return new Response(body, { status: 200, headers });
}

/** 指定バイト数を 1MiB チャンクで流すストリーム (巨大 ArrayBuffer を確保しない)。 */
function streamOfSize(totalBytes: number): ReadableStream<Uint8Array> {
  const CHUNK = 1024 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

describe('fetchAndStoreIncomingMedia — video', () => {
  test('本体 + preview を R2 に保存し video JSON を返す', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/content/preview')) {
        return okResponse(new ArrayBuffer(64), 'image/jpeg');
      }
      return okResponse(new ArrayBuffer(2048), 'video/mp4');
    }) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-v',
      kind: 'video',
    });

    // キーには推測不能な UUID が混ざる (公開ルートの総当たり対策)
    expect(puts[0].key).toMatch(/^incoming-acc-1-msg-v-[0-9a-f-]{36}\.mp4$/);
    // サムネイルは本体と同じトークンを共有し、`-preview` suffix で導出できる
    expect(puts[1].key).toBe(puts[0].key.replace(/\.mp4$/, '-preview.jpg'));
    expect(result).toEqual({
      type: 'video',
      originalContentUrl: `https://worker.example.com/images/${puts[0].key}`,
      previewImageUrl: `https://worker.example.com/images/${puts[1].key}`,
    });
    expect(puts[0].opts.httpMetadata?.contentType).toBe('video/mp4');
    // 動画/音声には Content-Disposition を付けない (インライン再生を壊さないため)
    expect(puts[0].opts.customMetadata).toBeUndefined();
  });

  test('preview が取れなければ previewImageUrl は本体 URL にフォールバック', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/content/preview')) return new Response(null, { status: 404 });
      return okResponse(new ArrayBuffer(2048), 'video/mp4');
    }) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-v2',
      kind: 'video',
    });

    const url = `https://worker.example.com/images/${puts[0].key}`;
    expect(result).toEqual({ type: 'video', originalContentUrl: url, previewImageUrl: url });
  });
});

describe('fetchAndStoreIncomingMedia — audio', () => {
  test('duration 付きの audio JSON を返す', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async () => okResponse(new ArrayBuffer(1024), 'audio/x-m4a')) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-a',
      kind: 'audio',
      duration: 12345,
    });

    expect(puts[0].key).toMatch(/^incoming-acc-1-msg-a-[0-9a-f-]{36}\.m4a$/);
    expect(result).toEqual({
      type: 'audio',
      originalContentUrl: `https://worker.example.com/images/${puts[0].key}`,
      duration: 12345,
    });
    expect(puts[0].opts.httpMetadata?.contentType).toBe('audio/x-m4a');
  });

  test('duration が無ければ省略される', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async () => okResponse(new ArrayBuffer(1024), 'audio/x-m4a')) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-a2',
      kind: 'audio',
    });

    expect(result).toEqual({
      type: 'audio',
      originalContentUrl: `https://worker.example.com/images/${puts[0].key}`,
    });
    expect(result && 'duration' in result).toBe(false);
  });
});

describe('fetchAndStoreIncomingMedia — file', () => {
  test('日本語ファイル名の PDF を保存し file JSON を返す', async () => {
    const { r2, puts } = makeR2Stub();
    // LINE は file を application/octet-stream で返すことが多い
    const fetchMock = vi.fn(async () => okResponse(new ArrayBuffer(4096), 'application/octet-stream')) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-f',
      kind: 'file',
      fileName: '見積書.pdf',
      fileSize: 123456,
    });

    expect(puts[0].key).toMatch(/^incoming-acc-1-msg-f-[0-9a-f-]{36}\.pdf$/);
    expect(result).toEqual({
      type: 'file',
      url: `https://worker.example.com/images/${puts[0].key}`,
      fileName: '見積書.pdf',
      fileSize: 123456,
    });
    // 拡張子から Content-Type を復元してブラウザで開けるようにする
    expect(puts[0].opts.httpMetadata?.contentType).toBe('application/pdf');
    // 日本語名は percent-encode して customMetadata に入る (S3 互換メタデータは ASCII 前提)
    expect(puts[0].opts.customMetadata?.downloadName).toBe(encodeURIComponent('見積書.pdf'));
  });

  test('fileName が無ければ拡張子は Content-Type 由来 / fileName は省略', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async () => okResponse(new ArrayBuffer(512), 'application/pdf')) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-f2',
      kind: 'file',
    });

    expect(result).toEqual({
      type: 'file',
      url: `https://worker.example.com/images/${puts[0].key}`,
    });
    expect(puts[0].opts.customMetadata).toBeUndefined();
  });

  test('HTML はスクリプト実行され得るので octet-stream に落として保存する', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async () => okResponse('<script>alert(1)</script>', 'text/html')) as unknown as typeof fetch;

    await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-f3',
      kind: 'file',
      fileName: 'evil.html',
    });

    expect(puts[0].opts.httpMetadata?.contentType).toBe('application/octet-stream');
  });
});

describe('fetchAndStoreIncomingMedia — メモリ安全性', () => {
  test('arrayBuffer() を経由せず ReadableStream のまま R2 に渡す', async () => {
    const { r2, puts } = makeR2Stub();
    const res = okResponse(new ArrayBuffer(2048), 'video/mp4');
    const arrayBufferSpy = vi.spyOn(res, 'arrayBuffer');
    const textSpy = vi.spyOn(res, 'text');
    const blobSpy = vi.spyOn(res, 'blob');
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/content/preview')) return new Response(null, { status: 404 });
      return res;
    }) as unknown as typeof fetch;

    await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-stream',
      kind: 'video',
    });

    expect(puts[0].value).toBeInstanceOf(ReadableStream);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(blobSpy).not.toHaveBeenCalled();
  });

  test('Content-Length が上限を超えたら保存せず null (ラベルにフォールバック)', async () => {
    const { r2 } = makeR2Stub();
    const oversized = MAX_INCOMING_MEDIA_BYTES.video + 1;
    const res = okResponse(new ArrayBuffer(8), 'video/mp4', oversized);
    const arrayBufferSpy = vi.spyOn(res, 'arrayBuffer');
    const fetchMock = vi.fn(async () => res) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-big',
      kind: 'video',
    });

    expect(result).toBeNull();
    expect(r2.put).not.toHaveBeenCalled();
    // 上限判定のために本体を読み込んでしまっては意味が無い
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  test('Content-Length 無しでも実バイト数が上限を超えたら打ち切って null', async () => {
    const { r2, deleted } = makeR2Stub();
    const overLimit = MAX_INCOMING_MEDIA_BYTES.file + 1024 * 1024;
    const res = new Response(streamOfSize(overLimit), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
    expect(res.headers.get('Content-Length')).toBeNull();
    const fetchMock = vi.fn(async () => res) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-nolen',
      kind: 'file',
      fileName: 'huge.pdf',
    });

    expect(result).toBeNull();
    // 途中まで書かれたオブジェクトは掃除する
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^incoming-acc-1-msg-nolen-[0-9a-f-]{36}\.pdf$/);
  });
});

describe('fetchAndStoreIncomingMedia — 失敗時フォールバック', () => {
  test('Content API が非 200 なら null', async () => {
    const { r2 } = makeR2Stub();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-401',
      kind: 'video',
    });

    expect(result).toBeNull();
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('ネットワークエラーでも throw せず null', async () => {
    const { r2 } = makeR2Stub();
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      fetchAndStoreIncomingMedia({
        ...baseOpts(r2, fetchMock),
        messageId: 'msg-net',
        kind: 'audio',
      }),
    ).resolves.toBeNull();
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('R2 put が throw しても throw せず null', async () => {
    const { r2 } = makeR2Stub();
    r2.put.mockRejectedValueOnce(new Error('R2 down'));
    const fetchMock = vi.fn(async () => okResponse(new ArrayBuffer(256), 'audio/x-m4a')) as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-r2',
      kind: 'audio',
    });

    expect(result).toBeNull();
  });

  test('kind=image は fetchAndStoreIncomingImage 側の責務なので null を返すだけ', async () => {
    const { r2 } = makeR2Stub();
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-img',
      kind: 'image',
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchAndStoreIncomingMedia — R2 キーの推測不能性', () => {
  test('同じ accountId / messageId でも保存ごとにキーが変わる', async () => {
    // GET /images/:key は認証なしの公開ルート。accountId は単一アカウント構成だと
    // 'unknown' 固定になり、LINE の messageId は時刻ベースで隣接値を総当たりできる。
    // 決定的なキーに戻す実装変更を弾くための回帰テスト。
    const fetchMock = vi.fn(async () => okResponse(new ArrayBuffer(128), 'application/pdf')) as unknown as typeof fetch;

    const first = makeR2Stub();
    await fetchAndStoreIncomingMedia({
      ...baseOpts(first.r2, fetchMock),
      accountId: 'unknown',
      messageId: '100000000000000000',
      kind: 'file',
      fileName: 'quote.pdf',
    });

    const second = makeR2Stub();
    await fetchAndStoreIncomingMedia({
      ...baseOpts(second.r2, fetchMock),
      accountId: 'unknown',
      messageId: '100000000000000000',
      kind: 'file',
      fileName: 'quote.pdf',
    });

    expect(first.puts[0].key).not.toBe(second.puts[0].key);
    // accountId / messageId は追跡用に残しつつ、ランダムトークンが付く
    expect(first.puts[0].key).toMatch(/^incoming-unknown-100000000000000000-[0-9a-f-]{36}\.pdf$/);
    expect(second.puts[0].key).toMatch(/^incoming-unknown-100000000000000000-[0-9a-f-]{36}\.pdf$/);
  });

  test('動画本体とサムネイルは同じトークンを共有する (suffix で対応関係を保つ)', async () => {
    const { r2, puts } = makeR2Stub();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/content/preview')) return okResponse(new ArrayBuffer(64), 'image/jpeg');
      return okResponse(new ArrayBuffer(256), 'video/mp4');
    }) as unknown as typeof fetch;

    await fetchAndStoreIncomingMedia({
      ...baseOpts(r2, fetchMock),
      messageId: 'msg-pair',
      kind: 'video',
    });

    const token = /^incoming-acc-1-msg-pair-([0-9a-f-]{36})\.mp4$/.exec(puts[0].key)?.[1];
    expect(token).toBeTruthy();
    expect(puts[1].key).toBe(`incoming-acc-1-msg-pair-${token}-preview.jpg`);
  });
});
