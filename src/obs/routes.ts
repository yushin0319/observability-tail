/**
 * 観測性イベントの受付エンドポイント。
 *
 * - POST /obs-notify                 : X-Webhook-Secret = WEBHOOK_SECRET。本文・応答は n8n の api/obs-notify と同じ
 * - POST /obs-from/{name}            : X-Adapter-Token = ADAPTER_TOKEN
 * - POST /obs-from/{name}/{token}    : パス末尾 = ADAPTER_TOKEN (ヘッダを付けられない Sentry 用)
 *   name = sentry | healthchecks | grafana | netdata。変換後は /obs-notify と同じ処理に通す。
 *
 * 認証に通らなければ 403 (本文なし)。認証後に payload が不正なら 400 を返し、
 * 受け付けられなかったことを観測性 DB に warning で残す。
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
  if (!env.NOTION_TOKEN) return notConfigured();

  const route = "/obs-notify";
  const parsed = await readBody(request);
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
  const authorized = await matchesSecret(
    [request.headers.get("X-Adapter-Token"), decodeSegment(pathToken)],
    env.ADAPTER_TOKEN,
  );
  if (!authorized) return forbidden();
  if (!env.NOTION_TOKEN) return notConfigured();

  // 記録にトークンを残さないよう、route はパスの adapter 名までにする
  const route = `/obs-from/${name}`;
  const parsed = await readBody(request);
  if (!parsed.ok) {
    return reject(env, ctx, route, "ParseBody", parsed.error, parsed.raw);
  }

  let payloads: ObsNotifyPayload[];
  try {
    payloads = adapter.convert(parsed.body);
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
  // (Notion に書けたかは件数で返す。書けなかった分は queued か failed に入る)
  const written = results.filter((r) => r.notion.ok).length;
  const queued = results.filter((r) => !r.notion.ok && r.notion.queued).length;
  return Response.json({
    success: true,
    forwarded: true,
    items: results.length,
    written,
    queued,
    failed: results.length - written - queued,
  });
}

/** 受け付けられなかった payload を warning で記録してから 400 を返す */
async function reject(
  env: ObsEnv,
  ctx: ExecutionContext | undefined,
  route: string,
  step: string,
  message: string,
  raw: unknown,
): Promise<Response> {
  await runToCompletion(
    ctx,
    processPayloads(env, [rejectionPayload(route, step, message, raw)]),
  );
  return Response.json({ success: false, error: message }, { status: 400 });
}

type ParsedBody =
  | { ok: true; body: unknown }
  | { ok: false; error: string; raw: string };

/**
 * n8n の Webhook ノードと同様に本文を読む: 空なら {}、JSON、
 * application/x-www-form-urlencoded ならキーと値のオブジェクト。
 */
async function readBody(request: Request): Promise<ParsedBody> {
  const text = await request.text();
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
