# observability-tail

Cloudflare Workers Tail Worker。upstream Workers（shirankedo / swipe-persona-api / worldpulse-api）の `level=error` / 例外を Discord に通知し、AI が後追い query できるよう 7 日間の error 履歴を KV に保存する。

## 仕組み

```
shirankedo / worldpulse-api / swipe-persona-api
   │  (各 wrangler に tail_consumers でこの Worker を指定)
   ▼
observability-tail (この Worker)
   │  level=error / exception を抽出
   │  DEDUP_KV (TTL 60s) で重複抑制
   │  ERROR_LOG_KV (TTL 7d) に履歴保存
   ▼
   ├──> Discord webhook (DISCORD_WEBHOOK_URL)
   └──> GET /errors?since=1h&script=worldpulse-api  (Bearer 認証で AI が pull)
```

## エンドポイント

- **tail event**（自動）— upstream Worker の log/exception を受信
- **`GET /errors?since=1h&limit=200&script=<name>`** — KV から該当期間の error を JSON で返す。`Authorization: Bearer $READ_TOKEN` 必須

## KV / Secret

| 名前 | 用途 | TTL |
|---|---|---|
| `DEDUP_KV` | エラーメッセージ先頭 200 文字 hash を保存して重複抑制 | 60s |
| `ERROR_LOG_KV` | 構造化 error log を保存（AI クエリ用） | 7d |
| `DISCORD_WEBHOOK_URL` (secret) | Discord 通知先 | — |
| `READ_TOKEN` (secret) | `/errors` API の Bearer 認証 | — |

## セットアップ

```bash
# KV namespace 作成（id を wrangler.toml に貼る）
bunx wrangler kv namespace create observability-tail-dedup
bunx wrangler kv namespace create observability-tail-error-log

# secret 設定
bunx wrangler secret put DISCORD_WEBHOOK_URL
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

上流 Worker でわざと例外を投げる → 数秒〜十数秒で Discord に embed が届く。60 秒以内の重複は 1 通のみ。後追い確認:

```bash
python ~/.claude/scripts/tail-errors.py --since 24h --script worldpulse-api
```

## 関連タスク

- Notion [M11] Cloudflare Workers 3本: Tail Worker で Discord にエラー即時通知
- Notion [A5] Worker エラー履歴 API（`GET /errors` + AI 用 CLI ラッパー）
