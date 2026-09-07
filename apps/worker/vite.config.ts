import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// React + Tailwind は salon-booking ページ (?page=salon-book) でのみ使う。
// main.ts から動的 import するので React チャンクは別ファイルに分離され、
// 既存の form / Google Calendar booking 利用者には load されない。
export default defineConfig({
  plugins: [cloudflare(), react(), tailwindcss()],
  // dev サーバーの CORS を無効化する。Vite は OPTIONS プリフライトに自前で
  // 応答してしまい、Worker の cors ミドルウェア (credentials: true) まで
  // 届かないため、管理画面 (localhost:3001) からの credentialed fetch が
  // ブラウザに弾かれる。本番は Pages ⇄ Workers が直接話すので無関係。
  server: { cors: false },
});
