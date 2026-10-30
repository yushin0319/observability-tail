/**
 * 観測性イベントの受付エンドポイント。
 *
 * - POST /obs-notify                : X-Webhook-Secret = WEBHOOK_SECRET。本文・応答は n8n の api/obs-notify と同じ
 * - POST /obs-from/sentry/{token}   : パス末尾 = SENTRY_ADAPTER_TOKEN (Sentry は webhook にヘッダを付けられない)
 * - POST /obs-from/sentry           : X-Adapter-Token = SENTRY_ADAPTER_TOKEN
 * - POST /obs-from/{healthchecks|grafana|netdata} : X-Adapter-Token = ADAPTER_TOKEN (パス末尾のトークンは受けない)
 *   変換後は /obs-notify と同じ処理に通す。Grafana の alerts[] は先頭 50 件だけ扱う。
 *
 * 認証に通らなければ 403 (本文なし)。認証後、本文が 256,000 バイトを超えたら 413、
 * payload が不正なら 400 を返し、受け付けられなかったことを観測性 DB に warning で残す。
 * 処理は ctx.waitUntil にも渡し、送り元が先に切断しても書き込み・再送キュー投入まで終える。
 */
import { matchesSecret } from "./auth";
import { InvocationBudget } from "./budget";
import { CONVERTERS } from "./converters";
import type { ObsNotifyPayload } from "./obsNotifyPayload";
import {
  deliverPrepared,
  prepareAll,
  processPayloads,
  rejectionPayload,
} from "./process";
import type { PreparedNotify } from "./prepNotify";
import type { ObsEnv } from "./types";

/** 受け付ける本文の上限 (バイト) */
export const MAX_BODY_BYTES = 256_000;

const OBS_FROM_RE = /^\/obs-from\/([^/]+)(?:\/([^/]+))?\/?$/;

/** /obs-notify・/obs-from/* なら処理して Response を返す。対象外のパスは null */
export async function routeObsRequest(
  request: Request,
  env: ObsEnv,
  ctx: ExecutionContext | undefined,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/obs-notify") {
    return handleObsNotify(request, env, ctx);
  }
  const m = pathname.match(OBS_FROM_RE);
  if (m) {
    return handleObsFrom(request, env, ctx, m[1], m[2]);
  }
  return null;
}

async function handleObsNotify(
  request: Request,
  env: ObsEnv,
  ctx: ExecutionContext | undefined,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const authorized = await matchesSecret(
    [request.headers.get("X-Webhook-Secret")],
    env.WEBHOOK_SECRET,
  );
  if (!authorized) return forbidden();

  const route = "/obs-notify";
  const text = await readLimitedText(request);
  if (text === null) return rejectTooLarge(env, ctx, route, request);
  if (!env.NOTION_TOKEN) return notConfigured();

  const parsed = parseBody(text, request);
  if (!parsed.ok) {
    return reject(env, ctx, route, "ParseBody", parsed.error, parsed.raw);
  }

  let prepared: PreparedNotify[];
  try {
    prepared = prepareAll(env, [parsed.body]);
  } catch (e) {
    return reject(env, ctx, route, "PrepNotify", errorMessage(e), parsed.body);
  }

  const [res] = await runToCompletion(
    ctx,
    deliverPrepared(env, prepared, new InvocationBudget()),
  );
  return Response.json(res);
}

async function handleObsFrom(
  request: Request,
  env: ObsEnv,
  ctx: ExecutionContext | undefined,
  name: string,
  pathToken: string | undefined,
): Promise<Response> {
  const adapter = CONVERTERS.get(name);
  if (!adapter) return new Response("not found", { status: 404 });
  if (request.method !== "POST") return methodNotAllowed();
  if (!(await adapterAuthorized(request, env, name, pathToken))) {
    return forbidden();
  }

  // 記録にトークンを残さないよう、route はパスの adapter 名までにする
  const route = `/obs-from/${name}`;
  const text = await readLimitedText(request);
  if (text === null) return rejectTooLarge(env, ctx, route, request);
  if (!env.NOTION_TOKEN) return notConfigured();

  const parsed = parseBody(text, request);
  if (!parsed.ok) {
    return reject(env, ctx, route, "ParseBody", parsed.error, parsed.raw);
  }

  const capped = adapter.cap
    ? adapter.cap(parsed.body)
    : { body: parsed.body, dropped: 0 };
  if (capped.dropped > 0) {
    console.log(
      JSON.stringify({ type: "obs_adapter_items_dropped", route, dropped: capped.dropped }),
    );
  }

  let payloads: ObsNotifyPayload[];
  try {
    payloads = adapter.convert(capped.body);
  } catch (e) {
    return reject(env, ctx, route, adapter.step, errorMessage(e), parsed.body);
  }
  let prepared: PreparedNotify[];
  try {
    prepared = prepareAll(env, payloads);
  } catch (e) {
    return reject(env, ctx, route, "PrepNotify", errorMessage(e), parsed.body);
  }

  const results = await runToCompletion(
    ctx,
    deliverPrepared(env, prepared, new InvocationBudget()),
  );
  // n8n の adapter と同じく、転送できたら success:true / forwarded:true を返す
  // (Notion に書けたかは件数で返す。書けなかった分は queued か failed、上限で切った分は dropped)
  const written = results.filter((r) => r.notion.ok).length;
  const queued = results.filter((r) => !r.notion.ok && r.notion.queued).length;
  return Response.json({
    success: true,
    forwarded: true,
    items: results.length,
    written,
    queued,
    failed: results.length - written - queued,
    dropped: capped.dropped,
  });
}

/**
 * adapter の認証。Sentry だけはパス末尾のトークンを受け、専用の SENTRY_ADAPTER_TOKEN で照合する。
 * それ以外はヘッダのみ (パス末尾にトークンが付いていたら 403)。
 */
async function adapterAuthorized(
  request: Request,
  env: ObsEnv,
  name: string,
  pathToken: string | undefined,
): Promise<boolean> {
  const header = request.headers.get("X-Adapter-Token");
  if (name === "sentry") {
    return matchesSecret([header, decodeSegment(pathToken)], env.SENTRY_ADAPTER_TOKEN);
  }
  if (pathToken !== undefined) return false;
  return matchesSecret([header], env.ADAPTER_TOKEN);
}

/** 受け付けられなかった payload を warning で記録してからエラー応答を返す */
async function reject(
  env: ObsEnv,
  ctx: ExecutionContext | undefined,
  route: string,
  step: string,
  message: string,
  raw: unknown,
  status = 400,
): Promise<Response> {
  await runToCompletion(
    ctx,
    processPayloads(env, [rejectionPayload(route, step, message, raw)]),
  );
  return Response.json({ success: false, error: message }, { status });
}

function rejectTooLarge(
  env: ObsEnv,
  ctx: ExecutionContext | undefined,
  route: string,
  request: Request,
): Promise<Response> {
  return reject(
    env,
    ctx,
    route,
    "ReadBody",
    `request body exceeds ${MAX_BODY_BYTES} bytes`,
    { content_length: request.headers.get("Content-Length") },
    413,
  );
}

/**
 * 本文を上限付きで読む。上限を超えたら null。
 * Content-Length が上限を超えていれば読まずに null、無ければストリームで読みながら数える。
 */
async function readLimitedText(request: Request): Promise<string | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type ParsedBody =
  | { ok: true; body: unknown }
  | { ok: false; error: string; raw: string };

/**
 * n8n の Webhook ノードと同様に本文を解釈する: 空なら {}、JSON、
 * application/x-www-form-urlencoded ならキーと値のオブジェクト。
 */
function parseBody(text: string, request: Request): ParsedBody {
  if (text.trim() === "") return { ok: true, body: {} };
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return { ok: true, body: Object.fromEntries(new URLSearchParams(text)) };
  }
  const body = parseJson(text);
  if (body === undefined) {
    return { ok: false, error: "request body is not valid JSON", raw: text.slice(0, 2000) };
  }
  return { ok: true, body };
}

/** JSON として読めなければ undefined (呼び出し側で 400 にする) */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 応答を待つ間に送り元が切断しても処理を打ち切られないよう waitUntil にも渡す */
function runToCompletion<T>(
  ctx: ExecutionContext | undefined,
  work: Promise<T>,
): Promise<T> {
  // 失敗は戻り値の Promise 側で呼び出し元に伝わる。waitUntil 側では二重に投げない
  ctx?.waitUntil(work.then(() => undefined, () => undefined));
  return work;
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function forbidden(): Response {
  return new Response(null, { status: 403 });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

function notConfigured(): Response {
  return Response.json(
    { success: false, error: "NOTION_TOKEN not configured" },
    { status: 503 },
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
