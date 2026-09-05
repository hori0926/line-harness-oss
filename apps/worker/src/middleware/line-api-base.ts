import type { Context, Next } from 'hono';
import { configureLineApiBase } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

/**
 * LINE API のベース URL を環境変数から line-sdk に流し込む。
 *
 * ⚠️ 警告 — **ローカル開発専用の逃げ道です。**
 *
 *   LINE_API_BASE_URL / LINE_CONTENT_API_BASE_URL を設定すると、
 *   この Worker が LINE へ送るはずのリクエストが丸ごと指定ホストへ向きます。
 *   そこには **チャネルアクセストークン (Bearer)**、**友だちの LINE userId**、
 *   **送信メッセージ本文**、そして受信メディア取得の応答経路が含まれます。
 *   本番・ステージング、あるいは実在の顧客が友だち登録しているアカウントを
 *   扱う環境でうっかり設定すると、顧客の個人情報と資格情報を第三者の
 *   サーバーへ送り出す経路そのものになります。
 *
 *   したがって:
 *     - この 2 つの変数は wrangler.toml の [vars] に **書かない** こと
 *       (デプロイに紛れ込む)。ローカルの apps/worker/.dev.vars だけに書く。
 *     - .dev.vars は .gitignore 済み。絶対にコミットしないこと。
 *     - 本番 Worker では `wrangler secret list` / `[vars]` に
 *       これらの名前が存在しないことを確認すること。
 *
 *   **未設定のときは既定の本番 URL (api.line.me / api-data.line.me) が使われ、
 *   挙動は従来と完全に同一です。**
 *
 * 毎リクエストで呼ぶのは、Workers の isolate がリクエストをまたいで
 * 再利用される (= module スコープの値が前のリクエストのまま残る) ためで、
 * 中身は文字列の代入だけなのでコストは無視できる。
 */
export function applyLineApiBase(env: Env['Bindings']): void {
  configureLineApiBase({
    apiBaseUrl: env.LINE_API_BASE_URL,
    contentApiBaseUrl: env.LINE_CONTENT_API_BASE_URL,
  });
}

export async function lineApiBaseMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<void> {
  applyLineApiBase(c.env);
  return next();
}
