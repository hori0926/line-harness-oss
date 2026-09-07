# PCでの手動返信へ移行する手順

このforkの最初の運用は **AIなし・人が管理画面から返信する構成**です。
`MANUAL_REPLY_ONLY=true` を設定すると、署名検証済みWebhookをCloudflare Queueへ
保存してからLINEへ成功を返します。Webhookの自動返信・イベントバスと定期配信は
動かしません。既存の自動化を含むDBを持ち込まず、新しい専用DBから始めます。
管理者向けの一斉送信・自動化API自体を削除するモードではありません。

## できることと移行時の差分

| 業務 | 現状 |
| --- | --- |
| テキスト・画像の送信 | 管理画面から送信可能 |
| 引用返信 | テキストで返信。引用元のトークンを保持 |
| 画像・動画・音声・ファイルの受信 | R2へ保存。動画・音声は再生、ファイルはダウンロード |
| 複数担当者 | 各人のスタッフアカウントを作る。送信者名を記録 |
| 二重対応防止 | 会話を開くと90秒の担当ロック。表示中は20秒ごとに更新。別の人は閲覧・下書きが可能、送信は拒否 |
| 不確かな送信結果の再試行 | 画面は同じ送信IDを再利用。LINEのretry keyで二重送信を防止。23時間経過後は自動再送しない |
| 未対応／対応中／解決済・メモ・タグ | 既存機能を利用 |
| 別の会話の新着 | 15秒ごとに軽量な更新確認。画面上の通知から一覧を更新 |
| 過去の会話履歴 | この実装には公式管理画面からの履歴インポートはない。切替前の履歴は公式管理画面で参照する運用を確認 |
| 既存タグ・メモ | 自動移行はない。必要な対象・件数を確認して別途移す |
| PDF等のファイル送信 | 受信と異なる。Messaging APIに汎用file送信オブジェクトはない。現行画面の送信はテキスト・画像・Flex。必要なら承認した共有リンクを送る運用を決める |
| スタンプ・動画・音声の送信 | 現行チャット送信UIの対象外。普段使用していれば移行前の追加要件 |
| 履歴量 | 会話詳細は直近1,000件。古い履歴のページングは未実装 |

**料金の違い:** この実装の手動返信はPush APIです。公式管理画面のチャットと異なり
配信通数に計上されます。日次の返信量と契約プランの月間上限を確認してから切り替えます。
API受付成功は相手端末の既読・配達保証ではありません。

一次資料:
- [LINEのメッセージ種別](https://developers.line.biz/en/docs/messaging-api/message-types/)
- [LINEの配信通数](https://www.lycbiz.com/jp/news/line-official-account/20221031/)
- [LINE retry key](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)
- [Cloudflare Queueの再試行](https://developers.cloudflare.com/queues/configuration/batching-retries/)

## 1. 最初に決めるもの

- Cloudflare Account IDと、Workers / D1 / R2 / Pages / Queuesを操作できる専用API Token。
- テスト用LINE公式アカウントのMessaging API Channel Secretと長期Channel Access Token。
- 担当者の人数と、各人専用のログイン。全員でOwnerキーを共有すると担当ロックが同一人物扱いになります。
- 既存業務で必須の送信形式、履歴参照、タグ、定型文、返信件数。

Messaging APIと管理画面の手動返信だけなら、LINE Login / LIFF / Google OAuthは
最初の接続条件ではありません。顧客向けLIFFや予約連携を使う段階で追加します。

## 2. Cloudflareのリソース作成

以下は推奨名です。既存基盤から独立したリソースを使います。
Cloudflare認証後に、リポジトリ直下で実行します。既存名がある場合は内容を確認し、
別環境のDBやバケットを流用しないでください。

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create pgt-marketing-line-harness-internal
pnpm exec wrangler r2 bucket create pgt-marketing-line-harness-internal-images
pnpm exec wrangler queues create pgt-marketing-line-harness-internal-inbox
pnpm exec wrangler queues create pgt-marketing-line-harness-internal-inbox-dlq
pnpm exec wrangler pages project create pgt-marketing-line-harness-admin-internal --production-branch main
```

D1の作成結果のIDを控えます。WorkerのURLはアカウントのworkers.devサブドメインを使います。
Webhookを接続するまではテストユーザーも業務ユーザーもこの環境へ届きません。

## 3. GitHub設定

登録先は `hori0926/line-harness-oss`。
値はチャット・コミット・コマンド引数に貼らず、GitHub Settingsまたは対話入力を使います。

Secrets:

| 名前 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 専用デプロイトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 対象アカウント |
| `D1_DATABASE_NAME` | 作成したDB名 |
| `D1_DATABASE_ID` | 作成したDBのID |
| `NEXT_PUBLIC_API_URL` | `https://<Worker名>.<subdomain>.workers.dev` |

Variables:

| 名前 | 推奨値 |
| --- | --- |
| `WORKER_NAME` | `pgt-marketing-line-harness-internal` |
| `R2_BUCKET_NAME` | `pgt-marketing-line-harness-internal-images` |
| `INBOX_QUEUE_NAME` | `pgt-marketing-line-harness-internal-inbox` |
| `INBOX_DLQ_NAME` | `pgt-marketing-line-harness-internal-inbox-dlq` |
| `PAGES_PROJECT_NAME` | `pgt-marketing-line-harness-admin-internal` |
| `WORKER_URL` | `NEXT_PUBLIC_API_URL`と同じURL |
| `ADMIN_ORIGIN` | `https://pgt-marketing-line-harness-admin-internal.pages.dev` |
| `LINE_HARNESS_CLOUDFLARE_DEPLOY` | リソースと設定が揃った後に `true` |

GitHub Actionsを有効化し、WorkerとAdminのdeploy workflowを実行します。
空のD1は完成形のbootstrapとmigration台帳から初期化されます。
台帳のない既存DBに過去のmigrationを推測で流すことはせず、明示的に停止します。

## 4. Worker secretsとLINE接続

初回Workerデプロイ後、以下を対話入力します。
環境変数での認証を使う場合もトークンをログへ表示しないでください。

```bash
pnpm exec wrangler secret put API_KEY --name pgt-marketing-line-harness-internal
pnpm exec wrangler secret put LINE_CHANNEL_SECRET --name pgt-marketing-line-harness-internal
pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --name pgt-marketing-line-harness-internal
```

`API_KEY`は十分にランダムなOwner専用キーにし、パスワード管理へ保存します。
管理画面へログインし、スタッフ管理で担当者ごとのキーを発行します。
複数のLINEチャネルを使う場合は、管理画面のLINEアカウント設定に登録します。
初期移行は単一のテストチャネルから始めます。

LINE DevelopersでWebhook URLを `https://<worker>/webhook` にし、検証・Webhook利用・再送を設定。
Official Account Manager側の既存あいさつ・応答設定も確認します。
本番のWebhookを替えるのは受入テストと返信担当者への周知が済んでからです。
WorkerのWebhook全体をCloudflare Accessで囲わないでください。
管理画面はスタッフ認証が必須です。追加でAccessを使う場合は管理画面側へ設定します。

## 5. 受入確認

- [ ] テストアカウントへ送ったテキストが画面に表示される。
- [ ] 引用あり／なしの返信が実際のLINE端末へ届く。
- [ ] 画像送信、画像・動画・音声・日本語名PDFの受信・再生・ダウンロード。
- [ ] 担当Aが会話を開くと、担当Bは閲覧できるが送信できない。
- [ ] Aが離れて90秒後にBが対応可能。スタッフ名が履歴に残る。
- [ ] メモ・タグ・解決済への変更、解決後の新しい受信が未対応へ戻る。
- [ ] 選択していない会話の新着通知、画面を再表示した際の更新、編集中の下書き維持。
- [ ] 送信中に通信が切れても、同じ本文の再試行で二重送信しない。
- [ ] 担当者が普段の業務例を一巡し、使えない操作を洗い出した。
- [ ] 過去履歴の参照方法、既存タグ・メモの扱い、配信通数と費用を確認した。

ローカル検証済みと実LINE受入済みは別です。上記チェックは実LINEで完了するまで未完了です。

## 6. 運用監視と障害時

- Queue backlog、consumer失敗、DLQ件数をCloudflareで確認します。DLQが1件以上なら調査。
- 添付は最大10回の再試行後に「取得失敗」を表示。元のジョブはDLQへ残ります。
  原因を直し、DLQから元のinboxへ再投入すると同じメッセージ行を更新します。
- 添付上限は画像10MiB／動画50MiB／音声20MiB／ファイル20MiB。
  上限超過は再試行で解消しません。別の共有方法を担当者に案内します。
- 添付URLは推測困難なURLを知る人が取得可能な方式です。認証付き添付を必須とする
  会社では、この点を解消するまで機密データを接続しません。
- 返信結果が不確かなときは同じ画面・同じ本文で再試行します。23時間経過した操作は
  管理者が履歴を確認します。新しい送信IDを作って闇雲に再送しません。
- Cloudflare D1/R2のバックアップ・保存期間・アクセス権を会社の運用に合わせます。
- 問題時は担当者の送信を止め、元のWebhook URLと公式管理画面の応答設定へ戻します。
  移行後の履歴を保全し、追加済みDB列は削除しません。

## 7. Penguin Platform

動作確認後、`apps/platform/portal/shared/systems.overrides.json` 等の既存カタログ規約に
従って管理画面への外部リンクを追加します。URLがまだない段階でリンクを公開しません。
LINE Harnessは同じCloudflareアカウント上の独立アプリとして運用します。

## ローカル検証コマンド

```bash
pnpm -r --if-present test
pnpm test:scripts
node scripts/dev/test-manual-runtime.mjs
pnpm --filter worker typecheck
pnpm --filter worker build
pnpm --filter web build
```

`test-manual-runtime.mjs`は実workerd/D1/R2で分割保存・担当ロック・重複受信・
送信後のDB障害・再試行・プロフィール再取得・失敗添付の復旧を検証します。
LINEへの送信部分はモックです。本番資格情報や本番顧客への送信は使いません。
