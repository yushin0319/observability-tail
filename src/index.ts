/**
 * Cloudflare Tail Worker (M11) + Error History API (A5) + 観測性イベント受付 (obs-notify).
 *
 * 別 Worker (shirankedo / swipe-persona-api / worldpulse-api) の tail event を
 * 受信し:
 * 1. level=error / exception を観測性イベント (severity=warning) として処理する
 *    → src/obs/process.ts が Notion 観測性ログ DB に書き込む (HTTP を経由せず直接呼ぶ)
 * 2. ERROR_LOG_KV に 7 日 TTL で保存し、GET /errors で AI が query 可能（A5）
 *
 * - 通知元 Worker 側の wrangler 設定に `[[tail_consumers]]` を追加すると、
 *   その Worker のリクエストごとに `tail` ハンドラへ TraceItem が流れてくる。
 * - 重複通知を避けるため、エラーメッセージ先頭 200 文字の hash を 60 秒 TTL の
 *   DEDUP_KV に書き込み、KV ヒット中は記録をスキップ。
 * - 1 回の tail 呼び出しで拾ったエラーはまとめて 1 回の processPayloads に渡す
 *   (直接書けない分は 1 回の sendBatch で再送キューへ)。
 * - GET /errors?since=1h は ERROR_LOG_KV から該当期間の error を返す。
 *   READ_TOKEN（wrangler secret）の Bearer auth 必須。
 * - POST /obs-notify・POST /obs-from/{sentry|healthchecks|grafana|netdata} で外部からの
 *   観測性イベントを受け付ける (src/obs/routes.ts)。Notion に書けなかった分は
 *   OBS_RETRY_QUEUE に積み、queue ハンドラが後から書き込む。
 */
import { matchesSecret } from "./obs/auth";
import { InvocationBudget } from "./obs/budget";
import type { ObsNotifyPayload } from "./obs/obsNotifyPayload";
import { consumeRetryBatch, processPayloads } from "./obs/process";
import { routeObsRequest } from "./obs/routes";
import { claimOnce, errorMessage, sha256Hex } from "./obs/shared";
import type { ObsEnv } from "./obs/types";

interface Env extends ObsEnv {
  DEDUP_KV: KVNamespace;
  ERROR_LOG_KV: KVNamespace;
  READ_TOKEN?: string;
}

/** scriptName (= Worker name) → repo 名のマッピング */
const SCRIPT_TO_REPO: Record<string, string> = {
  shirankedo: "shirankedo",
  "worldpulse-api": "WorldPulse",
  "swipe-persona-api": "swipe-persona",
  "observability-tail": "observability-tail",
};

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

const ERROR_LOG_TTL_SEC = 7 * 24 * 3600; // 7 日
const MESSAGE_TRUNCATE = 200;
/** KV のキーに使う hash の長さ (バイト)。既存のキーと揃える */
const MESSAGE_HASH_BYTES = 8;

export default {
  async tail(
    events: TailEvent[],
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // waitUntil にはイベント全体ではなく、拾ったエラーの必要な項目だけを渡す
    const errors: TailError[] = [];
    for (const event of events) {
      for (const item of collectErrors(event)) {
        errors.push({
          ts: event.eventTimestamp,
          scriptName: event.scriptName,
          outcome: event.outcome,
          kind: item.kind,
          message: item.message,
        });
      }
    }
    if (errors.length === 0) return;
    ctx.waitUntil(handleTailErrors(env, errors));
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/errors") {
      return handleGetErrors(request, env, url);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    const obsResponse = await routeObsRequest(request, env, ctx, url.pathname);
    if (obsResponse) return obsResponse;
    return new Response("not found", { status: 404 });
  },

  /** OBS_RETRY_QUEUE の consumer: Notion に書けなかった観測性イベントを再送する */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await consumeRetryBatch(batch, env);
  },
};

interface ErrorItem {
  kind: "log" | "exception";
  message: string;
}

/** tail で拾ったエラー 1 件 */
interface TailError {
  ts: number;
  scriptName: string | null;
  outcome: string;
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
    const message = stringifyMessage(log.message);
    // level=error は当然拾うが、shirankedo の logCronError 等が
    // console.log(JSON.stringify({type:"cron_failed",...})) で吐く JSON も
    // 取りこぼさないため type:"cron_failed" を含むログは error 扱いにする
    const isError = log.level === "error" || isCronFailedLog(message);
    if (!isError) continue;
    items.push({
      kind: "log",
      message,
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

const CRON_FAILED_RE = /"type"\s*:\s*"cron_failed"/;

function isCronFailedLog(message: string): boolean {
  return CRON_FAILED_RE.test(message);
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

/**
 * 1 回の tail 呼び出しで拾ったエラーを処理する:
 * 全件を ERROR_LOG_KV に保存し、60 秒以内に通知していないものだけまとめて観測性 DB に記録する。
 */
async function handleTailErrors(env: Env, errors: TailError[]): Promise<void> {
  // メッセージ先頭 200 文字の hash は、履歴のキーと重複抑制のキーの両方に使う
  const hashes = await Promise.all(
    errors.map((e) => sha256Hex(e.message.slice(0, MESSAGE_TRUNCATE), MESSAGE_HASH_BYTES)),
  );
  const [, notify] = await Promise.all([
    Promise.all(errors.map((e, i) => persistError(env, e, hashes[i]))),
    selectNotifiable(env, errors, hashes),
  ]);

  if (notify.payloads.length > 0) {
    // 受付エンドポイントと同じ処理を直接呼ぶ (Notion 書き込み + 失敗時は再送キュー)
    const results = await processPayloads(env, notify.payloads, new InvocationBudget());
    for (const res of results) {
      if (!res.notion.ok && !res.notion.queued) {
        console.log(
          JSON.stringify({ type: "obs_notify_error", error_code: res.notion.error_code }),
        );
      }
    }
  }
  // 重複抑制の KV が失敗したエラーは通知せず、失敗として waitUntil に返す (他のエラーの通知は止めない)
  if (notify.failures.length > 0) {
    throw new AggregateError(notify.failures, "tail dedup KV failed");
  }
}

/**
 * 通知するエラーを選ぶ。同じ Worker の同じメッセージ (先頭 200 文字) は 60 秒に 1 回。
 * 同じ呼び出しの中で重なったものも 1 回にまとめる。
 */
async function selectNotifiable(
  env: Env,
  errors: TailError[],
  hashes: string[],
): Promise<{ payloads: ObsNotifyPayload[]; failures: unknown[] }> {
  const candidates = new Map<string, TailError>();
  errors.forEach((e, i) => {
    const key = `${e.scriptName ?? "unknown"}:${hashes[i]}`;
    if (!candidates.has(key)) candidates.set(key, e);
  });

  const entries = [...candidates];
  const claims = await Promise.allSettled(
    entries.map(([key]) => claimOnce(env.DEDUP_KV, key)),
  );
  const payloads: ObsNotifyPayload[] = [];
  const failures: unknown[] = [];
  claims.forEach((claim, i) => {
    if (claim.status === "rejected") failures.push(claim.reason);
    else if (claim.value) payloads.push(tailPayload(entries[i][1]));
  });
  return { payloads, failures };
}

function tailPayload(e: TailError): ObsNotifyPayload {
  const scriptName = e.scriptName ?? "unknown";
  const repo = SCRIPT_TO_REPO[scriptName];
  return {
    severity: "warning",
    service: "cf-worker",
    subject: `⚠ ${scriptName} ${e.kind}`,
    summary: e.message.slice(0, 1500),
    ...(repo ? { repo } : {}),
    raw_payload: {
      scriptName,
      outcome: e.outcome,
      kind: e.kind,
      message: e.message.slice(0, 1500),
    },
  };
}

async function persistError(env: Env, e: TailError, hash: string): Promise<void> {
  // key: `error:{ts_ms_padded}:{shortHash}` → KV list({prefix:"error:"}) で時系列順に取れる
  const tsKey = String(e.ts).padStart(13, "0");
  const key = `error:${tsKey}:${hash}`;

  const value: StoredError = {
    ts: e.ts,
    scriptName: e.scriptName,
    outcome: e.outcome,
    kind: e.kind,
    message: e.message.slice(0, 4000), // KV value 上限考慮、十分長い
  };

  try {
    await env.ERROR_LOG_KV.put(key, JSON.stringify(value), {
      expirationTtl: ERROR_LOG_TTL_SEC,
    });
  } catch (err) {
    // 永続化失敗は本処理を止めない
    console.log(
      JSON.stringify({
        type: "error_log_persist_fail",
        error: errorMessage(err),
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
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!(await matchesSecret([token], env.READ_TOKEN))) {
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

  // KV list (prefix=error:) を cursor で全 page 走査。エラー件数 1000 超に対応。
  // key 形式 "error:{ts_padded}" は ASCII 順 = 時系列昇順なので、
  // 先に key 一覧を集めて cutoff 以降だけ get する。
  const matchedKeys: string[] = [];
  let cursor: string | undefined;
  // safety guard: 万一 KV にゴミが大量に入っても暴走しないよう page 数で打ち切り
  for (let page = 0; page < 50; page++) {
    const list = await env.ERROR_LOG_KV.list({
      prefix: "error:",
      limit: 1000,
      cursor,
    });
    for (const k of list.keys) {
      const parts = k.name.split(":");
      if (parts.length < 2) continue;
      const ts = Number(parts[1]);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      matchedKeys.push(k.name);
    }
    if (list.list_complete) break;
    cursor = list.cursor;
    if (!cursor) break;
  }

  // matched keys だけ get (limit より多くは get しない、無駄な KV read を避ける)
  const items: StoredError[] = [];
  // 新しい順に処理して limit に達したら止める
  matchedKeys.sort((a, b) => b.localeCompare(a));
  for (const name of matchedKeys) {
    if (items.length >= limit) break;
    const value = await env.ERROR_LOG_KV.get(name);
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as StoredError;
      if (scriptFilter && parsed.scriptName !== scriptFilter) continue;
      items.push(parsed);
    } catch {
      // skip
    }
  }
  // matchedKeys は ASCII 降順 = ts 降順なので items も既に降順
  // ただし script フィルタで間引かれるので最終的な件数は limit 以下になることがある

  return Response.json({
    since_ms: sinceMs,
    cutoff_iso: new Date(cutoff).toISOString(),
    count: items.length,
    matched_keys: matchedKeys.length,
    truncated: matchedKeys.length > items.length,
    items,
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
