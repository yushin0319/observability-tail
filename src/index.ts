/**
 * Cloudflare Tail Worker (M11).
 *
 * 別 Worker (shirankedo / swipe-persona-api / worldpulse-api) の tail event を
 * 受信し、level=error のログ または exception を Discord に通知する。
 *
 * - 通知元 Worker 側の wrangler 設定に `[[tail_consumers]]` を追加すると、
 *   その Worker のリクエストごとに `tail` ハンドラへ TraceItem が流れてくる。
 * - Discord webhook は env.DISCORD_WEBHOOK_URL（wrangler secret）で渡す。
 * - 重複通知を避けるため、エラーメッセージ先頭 200 文字の hash を 60 秒 TTL の
 *   KV に書き込み、KV ヒット中はスキップする（best effort、KV は eventually
 *   consistent なので短時間内の連発は突き抜ける可能性あり）。
 */

interface Env {
  DEDUP_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
}

interface TailLog {
  message: unknown[];
  level: string;
  timestamp: number;
}

interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

interface TailEvent {
  scriptName: string | null;
  outcome: string;
  logs: TailLog[];
  exceptions: TailException[];
  eventTimestamp: number;
  // 他にも event, scriptVersion, diagnosticsChannelEvents, dispatchNamespace 等あるが未使用
}

const DEDUP_TTL_SEC = 60;
const MESSAGE_TRUNCATE = 200;

export default {
  async tail(events: TailEvent[], env: Env, ctx: ExecutionContext): Promise<void> {
    for (const event of events) {
      const errorItems = collectErrors(event);
      if (errorItems.length === 0) continue;

      for (const item of errorItems) {
        ctx.waitUntil(maybeNotify(env, event, item));
      }
    }
  },
};

interface ErrorItem {
  kind: "log" | "exception";
  message: string;
  stack?: string;
}

function collectErrors(event: TailEvent): ErrorItem[] {
  const items: ErrorItem[] = [];

  for (const log of event.logs) {
    if (log.level !== "error") continue;
    items.push({
      kind: "log",
      message: stringifyMessage(log.message),
    });
  }

  for (const exc of event.exceptions) {
    items.push({
      kind: "exception",
      message: `${exc.name}: ${exc.message}`,
    });
  }

  return items;
}

function stringifyMessage(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");
}

async function maybeNotify(
  env: Env,
  event: TailEvent,
  item: ErrorItem,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const truncated = item.message.slice(0, MESSAGE_TRUNCATE);
  const hash = await sha256(truncated);
  const dedupKey = `${event.scriptName ?? "unknown"}:${hash}`;

  const cached = await env.DEDUP_KV.get(dedupKey);
  if (cached !== null) {
    // 60 秒以内に同一通知済み → skip
    return;
  }

  // 先に KV 書き込みで racing 通知を抑制
  await env.DEDUP_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SEC });

  const embed = {
    title: `⚠ ${event.scriptName ?? "unknown"} ${item.kind}`,
    description: "```\n" + item.message.slice(0, 1500) + "\n```",
    color: 0xe74c3c,
    timestamp: new Date(event.eventTimestamp).toISOString(),
    footer: { text: `outcome: ${event.outcome}` },
  };

  try {
    const resp = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!resp.ok) {
      // discord 失敗はサイレント（自身のエラーで再帰しないよう）
      console.log(
        JSON.stringify({
          type: "discord_error",
          status: resp.status,
        }),
      );
    }
  } catch (e) {
    console.log(
      JSON.stringify({
        type: "discord_exception",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
