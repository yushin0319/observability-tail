# observability-tail

Cloudflare Workers の観測用 Worker。2 つの役割がある。

1. **Tail Worker**: upstream Workers（shirankedo / swipe-persona-api / worldpulse-api）の `level=error` / 例外 / **`type:"cron_failed"` を含む `level=log`** を拾い、Notion 観測性ログ DB に記録する。AI が後追い query できるよう 7 日間の error 履歴を KV にも保存する
2. **アラートの受け口（obs-notify）**: 各サービス・SaaS からのアラートを受け、Notion 観測性ログ DB に記録し、critical だけ Discord `#obs-critical` に即時通知する。n8n の `api/obs-notify` / `api/obs-from-*` と同じ入出力で、n8n が止まっていても記録が残る

warning を Discord に 1 日 1 通まとめる `cron/obs-daily-digest` は n8n 側にある（Notion DB を読むだけ）。

## 仕組み

```
shirankedo / worldpulse-api / swipe-persona-api        各サービス・監視スクリプト        Sentry / Healthchecks.io / Grafana / Netdata
   │  (tail_consumers でこの Worker を指定)              │ POST /obs-notify                   │ POST /obs-from/{name}[/{token}]
   ▼                                                     │ (X-Webhook-Secret)                 │ (X-Adapter-Token かパス末尾)
observability-tail (この Worker) ◄──────────────────────┴────────────────────────────────────┘
   │  tail: level=error / exception、level=log の cron_failed を抽出
   │        DEDUP_KV (TTL 60s) で重複抑制、ERROR_LOG_KV (TTL 7d) に履歴保存、通知は受け口の処理を直接呼ぶ
   │  受け口: 検証（許可 service / repo / severity・長さ・url）→ critical なら Discord → Notion
   │        Notion が 429 / 5xx なら 2 秒おきに最大 3 回、それでも駄目なら Queue obs-notify-retry で 30 秒おきに再送
   ▼
   ├──> Notion 観測性ログ DB (3552570f-e49f-80a6-9186-c1a14b7d9547)
   ├──> Discord #obs-critical (critical のみ、@here)
   └──> GET /errors?since=1h&script=worldpulse-api  (Bearer 認証で AI が pull)
```

## error として拾う条件（tail）

| 種別 | 条件 |
|---|---|
| ログ | `level === "error"` |
| ログ | `level` を問わず本文に `"type":"cron_failed"` を含む（正規表現 `CRON_FAILED_RE`） |
| 例外 | `event.exceptions` に入っているもの全件 |

2 番目は shirankedo の `logCronError` が `console.log(JSON.stringify({type:"cron_failed", ...}))` で吐くため、`level=log` に埋もれた cron 失敗を取りこぼさないためのもの。scheduled handler が `outcome=success` のまま失敗を握りつぶす罠への対策として入っている。

## エンドポイント

- **tail event**（自動）— upstream Worker の log/exception を受信
- **`GET /errors?since=1h&limit=200&script=<name>`** — KV から該当期間の error を JSON で返す。`Authorization: Bearer $READ_TOKEN` 必須
- **`POST /obs-notify`** — `{ severity, service, subject, summary?, repo?, url?, raw_payload? }` を受ける（n8n の obs-notify と同じ）。`X-Webhook-Secret: $WEBHOOK_SECRET` 必須
- **`POST /obs-from/{sentry|healthchecks|grafana|netdata}`** — 各 SaaS の webhook 形式を変換して同じ処理に流す。`X-Adapter-Token: $ADAPTER_TOKEN` か、ヘッダを付けられない SaaS（Sentry 等）は `/obs-from/{name}/{ADAPTER_TOKEN}`
- 認証に失敗すると 403（本文なし）、未知のパスは 404、POST 以外は 405

## KV / Queue / Secret

| 名前 | 用途 | TTL |
|---|---|---|
| `DEDUP_KV` | エラーメッセージ先頭 200 文字 hash を保存して重複抑制 | 60s |
| `ERROR_LOG_KV` | 構造化 error log を保存（AI クエリ用） | 7d |
| Queue `obs-notify-retry`（binding `OBS_RETRY_QUEUE`） | Notion に書けなかったアラートの再送。最大 5 回、無料プランの保持は 24 時間 | — |
| `READ_TOKEN` (secret) | `/errors` API の Bearer 認証 | — |
| `WEBHOOK_SECRET` (secret) | `/obs-notify` の `X-Webhook-Secret`（n8n の nginx と同じ値にすると、送り元はヘッダを変えずに URL だけ差し替えられる） | — |
| `ADAPTER_TOKEN` (secret) | `/obs-from/*` の認証 | — |
| `NOTION_TOKEN` (secret) | 観測性ログ DB に書ける Notion integration のトークン。未設定だと受け口は 503 を返す | — |
| `DISCORD_CRITICAL_URL` (secret) | `#obs-critical` の webhook URL | — |

## セットアップ

```bash
# KV namespace 作成（id を wrangler.toml に貼る）
bunx wrangler kv namespace create observability-tail-dedup
bunx wrangler kv namespace create observability-tail-error-log

# 再送キュー作成（無いと wrangler deploy が止まる。main に入れる前に作る）
bunx wrangler queues create obs-notify-retry

# secret 設定（値はチャットに貼らない）
bunx wrangler secret put READ_TOKEN
bunx wrangler secret put WEBHOOK_SECRET
bunx wrangler secret put ADAPTER_TOKEN
bunx wrangler secret put NOTION_TOKEN
bunx wrangler secret put DISCORD_CRITICAL_URL

# デプロイ
bunx wrangler deploy
```

各上流 Worker の `wrangler.toml` / `wrangler.jsonc` に:

```toml
[[tail_consumers]]
service = "observability-tail"
```

```jsonc
"tail_consumers": [{ "service": "observability-tail" }]
```

## 開発・デプロイ

- TypeScript（`src/index.ts`、受け口は `src/obs/`）/ vitest / wrangler。パッケージマネージャは Bun（`bun.lock`）

```bash
bun install
bun run test         # vitest run
bun run typecheck    # tsc --noEmit
```

- CI（`.github/workflows/ci.yml`）: typecheck + vitest
- デプロイ（`.github/workflows/deploy.yml`）: main で CI が成功すると `bunx wrangler deploy` が自動で走る。上の手動 `bunx wrangler deploy` は初回セットアップ・緊急時用
- PR レビュー: `.github/workflows/gemini-review.yml`

## 動作確認

- tail: 上流 Worker でわざと例外を投げる → 数秒〜十数秒で Notion 観測性ログ DB に row 追加（warning は Discord に即時では来ない。23:00 JST の日次まとめに載る）。60 秒以内の重複は 1 件のみ。後追い確認:

```bash
python ~/.claude/scripts/tail-errors.py --since 24h --script worldpulse-api
```

- 受け口: info で 1 件送り、Notion 観測性ログ DB に 1 行増えたことを確かめる（`python ~/.claude/scripts/webhook.py notion-db-query '*' --file <q.json>`）。Worker 側の受信は `python ~/.claude/scripts/cf-logs.py observability-tail --since 10m`

## 関連タスク

- Notion [M11] Cloudflare Workers 3本: Tail Worker で Discord にエラー即時通知
- Notion [A5] Worker エラー履歴 API（`GET /errors` + AI 用 CLI ラッパー）
- Notion #529 Discord 観測性チャンネル整理（obs-notify 経由に切替済み）
- Notion [B2-3] obs-notify の受け口を Cloudflare Workers の無料枠に移す
