# observability-tail

Cloudflare Workers Tail Worker that forwards `level=error` logs and exceptions
from upstream Workers (shirankedo / swipe-persona-api / worldpulse-api) to a
Discord webhook.

## 仕組み

```
shirankedo / worldpulse-api / swipe-persona-api
   │  (各 wrangler に [[tail_consumers]] でこの Worker を指定)
   ▼
observability-tail (この Worker)
   │  level=error / exception を抽出
   │  KV (DEDUP_KV, TTL=60s) で重複抑制
   ▼
Discord webhook (DISCORD_WEBHOOK_URL secret)
```

## デプロイ

1. KV namespace を作成して `wrangler.toml` の `id` を置き換え:

   ```bash
   bunx wrangler kv namespace create observability-tail-dedup
   ```

2. Discord webhook secret を設定:

   ```bash
   bunx wrangler secret put DISCORD_WEBHOOK_URL
   ```

3. `bunx wrangler deploy`

4. 各上流 Worker の `wrangler.toml` / `wrangler.jsonc` に `tail_consumers` を追加:

   ```toml
   # toml
   [[tail_consumers]]
   service = "observability-tail"
   ```

   ```jsonc
   // jsonc
   "tail_consumers": [{ "service": "observability-tail" }]
   ```

## 動作確認

上流 Worker でわざと例外を投げる → 数秒〜十数秒で Discord に embed が届く。
60 秒以内に同じエラーが連続発生しても 1 通だけ通知される（KV dedup）。

## 関連タスク

- Notion: [M11] Cloudflare Workers 3本: Tail Worker で Discord にエラー即時通知
