#!/usr/bin/env bash
# scripts/dev/apply-local-db.sh
#
# ローカル D1 (miniflare: apps/worker/.wrangler/state/v3/d1) を作り直す。
# ローカル開発専用 — 常に --local を付けるのでリモート D1 には一切触らない。
#
#   bash scripts/dev/apply-local-db.sh
#
# 適用するのは packages/db/bootstrap.sql。これは
#   packages/db/schema.sql + packages/db/migrations/*.sql (073〜075 含む全 81 本)
# を実 SQLite 上で順に流して生成した「新規インストール用の完成形スキーマ」で、
# packages/db/scripts/generate-bootstrap.mjs が生成し bootstrap-meta.json に
# 取り込んだ migration 一覧が記録されている (本番インストーラもこれを使う)。
#
# schema.sql → migrations/*.sql を素直に順番に流す方法は使えない: schema.sql は
# 「現時点の完成スキーマ」なので、001_round2.sql の ALTER TABLE ADD COLUMN が
# 「duplicate column name: user_id」で必ず落ちる。逆に schema.sql だけでは
# migration で追加されたテーブル (webinars / events / forms / tracked_links …
# 26 テーブル) が丸ごと欠ける。bootstrap.sql はその両方を解決した成果物。
#
# 注意: worker の dev サーバー (vite dev) は止めてから実行すること
# (同じ SQLite ファイルを掴むため)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/apps/worker"

if [ "${KEEP_EXISTING:-0}" != "1" ]; then
  echo "→ ローカル D1 を初期化"
  rm -rf .wrangler/state/v3/d1
fi

echo "→ bootstrap.sql を適用"
pnpm exec wrangler d1 execute line-harness --local --yes \
  --file="$ROOT/packages/db/bootstrap.sql" > /dev/null

echo "→ 検証: 直近 migration (073/074) の列が存在するか"
pnpm exec wrangler d1 execute line-harness --local --yes --json \
  --command="SELECT name FROM pragma_table_info('messages_log') WHERE name IN ('quote_token','quoted_message_id','sent_by_staff_id','sent_by_staff_name') ORDER BY name" \
  | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const rows = JSON.parse(raw.slice(raw.indexOf("[")))[0].results.map((r) => r.name);
      const want = ["quote_token", "quoted_message_id", "sent_by_staff_id", "sent_by_staff_name"];
      const missing = want.filter((c) => !rows.includes(c));
      if (missing.length) {
        console.error("NG: messages_log に不足している列:", missing.join(", "));
        process.exit(1);
      }
      console.log("OK: messages_log に " + want.join(", ") + " があります");
    });
  '


# ─── Owner スタッフ (管理画面ログイン用) ───────────────────────────────────
# 管理画面は API キーをそのままログイン資格情報として使う (staff_members.api_key)。
# ローカル開発用に固定キーを入れておく。**開発専用の値で、本番には存在しない。**
DEV_OWNER_KEY="lh_devowner000000000000000000000001"
echo "→ Owner スタッフを作成 (api_key=$DEV_OWNER_KEY)"
pnpm exec wrangler d1 execute line-harness --local --yes --command \
  "INSERT OR REPLACE INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
   VALUES ('dev-owner-0001', '開発オーナー', 'dev-owner@example.test', 'owner', '$DEV_OWNER_KEY', 1,
           strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'), strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))" \
  > /dev/null

echo ""
echo "管理画面ログイン用 API キー: $DEV_OWNER_KEY"
echo "done."
