# observability-tail

Cloudflare Workers Tail Worker。upstream Workers（shirankedo / swipe-persona-api / worldpulse-api）の `level=error` / 例外 / **`type:"cron_failed"` を含む `level=log`** を **n8n の `api/obs-notify` 経由で Discord 通知 + Notion 観測性ログ DB に並行記録** し、AI が後追い query できるよう 7 日間の error 履歴を KV にも保存する。

## 仕組み

```
shirankedo / worldpulse-api / swipe-persona-api
   │  (各 wrangler に tail_consumers でこの Worker を指定)
   ▼
observability-tail (この Worker)
   │  level=error / exception を抽出
   │  + level=log でも `"type":"cron_failed"` を含むものは error 扱い
   │  DEDUP_KV (TTL 60s) で重複抑制
   │  ERROR_LOG_KV (TTL 7d) に履歴保存
   ▼
   ├──> n8n api/obs-notify (OBS_NOTIFY_URL, severity=warning, service=cf-worker)
   │       └──> #obs-warning channel + Notion 観測性ログ DB
   └──> GET /errors?since=1h&script=worldpulse-api  (Bearer 認証で AI が pull)
```

## error として拾う条件

| 種別 | 条件 |
|---|---|
| ログ | `level === "error"` |
| ログ | `level` を問わず本文に `"type":"cron_failed"` を含む（正規表現 `CRON_FAILED_RE`） |
| 例外 | `event.exceptions` に入っているもの全件 |

2 番目は shirankedo の `logCronError` が `console.log(JSON.stringify({type:"cron_failed", ...}))` で吐くため、`level=log` に埋もれた cron 失敗を取りこぼさないためのもの。scheduled handler が `outcome=success` のまま失敗を握りつぶす罠への対策として入っている。

## エンドポイント

- **tail event**（自動）— upstream Worker の log/exception を受信
- **`GET /errors?since=1h&limit=200&script=<name>`** — KV から該当期間の error を JSON で返す。`Authorization: Bearer $READ_TOKEN` 必須

## KV / Secret

| 名前 | 用途 | TTL |
|---|---|---|
| `DEDUP_KV` | エラーメッセージ先頭 200 文字 hash を保存して重複抑制 | 60s |
| `ERROR_LOG_KV` | 構造化 error log を保存（AI クエリ用） | 7d |
| `OBS_NOTIFY_URL` (secret) | n8n 観測性統一エンドポイント (例: `https://yushin-n8n.duckdns.org/webhook/obs-notify`) | — |
| `READ_TOKEN` (secret) | `/errors` API の Bearer 認証 | — |

## セットアップ

```bash
# KV namespace 作成（id を wrangler.toml に貼る）
bunx wrangler kv namespace create observability-tail-dedup
bunx wrangler kv namespace create observability-tail-error-log

# secret 設定
bunx wrangler secret put OBS_NOTIFY_URL
bunx wrangler secret put READ_TOKEN

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

## 動作確認

上流 Worker でわざと例外を投げる → 数秒〜十数秒で `#obs-warning` channel に通知 + Notion 観測性ログ DB に row 追加。60 秒以内の重複は 1 通のみ。後追い確認:

```bash
python ~/.claude/scripts/tail-errors.py --since 24h --script worldpulse-api
```

## 関連タスク

- Notion [M11] Cloudflare Workers 3本: Tail Worker で Discord にエラー即時通知
- Notion [A5] Worker エラー履歴 API（`GET /errors` + AI 用 CLI ラッパー）
- Notion #529 Discord 観測性チャンネル整理（obs-notify 経由に切替済み）
