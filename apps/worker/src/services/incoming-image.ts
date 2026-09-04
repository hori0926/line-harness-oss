import { fetchAndStoreIncomingImageInternal } from './incoming-media.js';
import type { FetchAndStoreIncomingMediaOptions, IncomingImageRefs } from './incoming-media.js';

export type FetchAndStoreOptions = Omit<FetchAndStoreIncomingMediaOptions, 'kind'>;
export type { IncomingImageRefs };

/**
 * LINE Content API から incoming 画像バイナリを取得し R2 に保存して URL を返す。
 * 失敗時は null を返し、呼び出し元は `[画像]` ラベルフォールバックを使う。
 *
 * 実装は動画/音声/ファイルと共通の incoming-media.ts に集約した。
 * 画像は既存行 (type フィールドの無い {originalContentUrl, previewImageUrl}) との
 * 互換があるため、戻り値の形と呼び出し口はこのモジュールで維持している。
 */
export async function fetchAndStoreIncomingImage(
  opts: FetchAndStoreOptions,
): Promise<IncomingImageRefs | null> {
  return fetchAndStoreIncomingImageInternal(opts);
}
