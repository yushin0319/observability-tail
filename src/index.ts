/**
 * Cloudflare Tail Worker (M11) + Error History API (A5).
 *
 * 別 Worker (shirankedo / swipe-persona-api / worldpulse-api) の tail event を
 * 受信し:
 * 1. level=error / exception を Discord に通知（M11）
 * 2. ERROR_LOG_KV に 7 日 TTL で保存し、GET /errors で AI が query 可能（A5）
 *
 * - 通知元 Worker 側の wrangler 設定に `[[tail_consumers]]` を追加すると、
 *   その Worker のリクエストごとに `tail` ハンドラへ TraceItem が流れてくる。
 * - Discord webhook は env.DISCORD_WEBHOOK_URL（wrangler secret）で渡す。
 * - 重複通知を避けるため、エラーメッセージ先頭 200 文字の hash を 60 秒 TTL の
 *   DEDUP_KV に書き込み、KV ヒット中は Discord 通知をスキップ。
 * - GET /errors?since=1h は ERROR_LOG_KV から該当期間の error を返す。
 *   READ_TOKEN（wrangler secret）の Bearer auth 必須。
 */

interface Env {
  DEDUP_KV: KVNamespace;
  ERROR_LOG_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  READ_TOKEN?: string;
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
}

const DEDUP_TTL_SEC = 60;
const ERROR_LOG_TTL_SEC = 7 * 24 * 3600; // 7 日
const MESSAGE_TRUNCATE = 200;

export default {
  async tail(
    events: TailEvent[],
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    for (const event of events) {
      const errorItems = collectErrors(event);
      if (errorItems.length === 0) continue;

      for (const item of errorItems) {
        ctx.waitUntil(persistError(env, event, item));
        ctx.waitUntil(maybeNotify(env, event, item));
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/errors") {
      return handleGetErrors(request, env, url);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};

interface ErrorItem {
  kind: "log" | "exception";
  message: string;
}

interface StoredError {
  ts: number;
  scriptName: string | null;
  outcome: string;
  kind: "log" | "exception";
  message: string;
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

async function persistError(
  env: Env,
  event: TailEvent,
  item: ErrorItem,
): Promise<void> {
  // key: `error:{ts_ms_padded}:{shortHash}` → KV list({prefix:"error:"}) で時系列順に取れる
  const ts = event.eventTimestamp;
  const tsKey = String(ts).padStart(13, "0");
  const hash = await sha256(item.message.slice(0, MESSAGE_TRUNCATE));
  const key = `error:${tsKey}:${hash}`;

  const value: StoredError = {
    ts,
    scriptName: event.scriptName,
    outcome: event.outcome,
    kind: item.kind,
    message: item.message.slice(0, 4000), // KV value 上限考慮、十分長い
  };

  try {
    await env.ERROR_LOG_KV.put(key, JSON.stringify(value), {
      expirationTtl: ERROR_LOG_TTL_SEC,
    });
  } catch (e) {
    // 永続化失敗は本処理を止めない
    console.log(
      JSON.stringify({
        type: "error_log_persist_fail",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
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

async function handleGetErrors(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  // Bearer auth: AI 用 CLI からのアクセスを READ_TOKEN で守る
  if (!env.READ_TOKEN) {
    return new Response("READ_TOKEN not configured", { status: 503 });
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== env.READ_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const sinceParam = url.searchParams.get("since") ?? "1h";
  const sinceMs = parseSince(sinceParam);
  const cutoff = Date.now() - sinceMs;
  const limit = Math.min(
    Number(url.searchParams.get("limit") ?? "200") || 200,
    1000,
  );
  const scriptFilter = url.searchParams.get("script");

  // KV list (prefix=error:) で全件取り、cutoff 以降のものだけ返す
  // 件数が多い場合に list を pagination するが、7 日 7000 件程度想定なので 1 page で足りる
  const list = await env.ERROR_LOG_KV.list({ prefix: "error:", limit: 1000 });

  const items: StoredError[] = [];
  for (const k of list.keys) {
    // key 形式: error:{ts_padded}:{hash}
    const parts = k.name.split(":");
    if (parts.length < 2) continue;
    const ts = Number(parts[1]);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    const value = await env.ERROR_LOG_KV.get(k.name);
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as StoredError;
      if (scriptFilter && parsed.scriptName !== scriptFilter) continue;
      items.push(parsed);
    } catch {
      // skip
    }
  }
  // 最新が先頭
  items.sort((a, b) => b.ts - a.ts);

  return Response.json({
    since_ms: sinceMs,
    cutoff_iso: new Date(cutoff).toISOString(),
    count: Math.min(items.length, limit),
    truncated: items.length > limit,
    items: items.slice(0, limit),
  });
}

function parseSince(s: string): number {
  // "1h" / "30m" / "10s" / 数値 (= ms)
  const m = s.match(/^(\d+)\s*([smhd])?$/);
  if (!m) return 3600 * 1000;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const factor =
    unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * factor;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
