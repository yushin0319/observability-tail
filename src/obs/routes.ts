/**
 * 観測性イベントの受付エンドポイント。どの受け口も intake() の同じ流れを通り、応答の形だけが違う。
 *
 * - POST /obs-notify                : X-Webhook-Secret = WEBHOOK_SECRET。本文・応答は n8n の api/obs-notify と同じ
 * - POST /obs-from/sentry/{token}   : パス末尾 = SENTRY_ADAPTER_TOKEN (Sentry は webhook にヘッダを付けられない)
 * - POST /obs-from/sentry           : X-Adapter-Token = SENTRY_ADAPTER_TOKEN
 * - POST /obs-from/{healthchecks|grafana|netdata} : X-Adapter-Token = ADAPTER_TOKEN (パス末尾のトークンは受けない)
 *   変換後は /obs-notify と同じ処理に通す。Grafana の alerts[] は先頭 50 件だけ扱う。
 *
 * 流れ: POST 以外 405 → 認証 (失敗は 403、本文なし) → NOTION_TOKEN 未設定 503
 *   → 本文 256,000 バイト超 413 → JSON 不正・変換失敗・検証失敗 400 → 送信 → 応答。
 * 413 / 400 のときは、受け付けられなかったことを観測性 DB に warning で残す。
 * 処理は ctx.waitUntil にも渡し、送り元が先に切断しても書き込み・再送キュー投入まで終える。
 */
import { matchesSecret } from "./auth";
import { InvocationBudget } from "./budget";
import { capGrafanaAlerts, convertGrafana } from "./converters/grafana";
import { convertHealthchecks } from "./converters/healthchecks";
import { convertNetdata } from "./converters/netdata";
import { convertSentry } from "./converters/sentry";
import type { ObsNotifyResponse } from "./formatResponse";
import {
  deliverPrepared,
  prepareAll,
  processPayloads,
  rejectionPayload,
} from "./process";
import type { PreparedNotify } from "./prepNotify";
import { errorMessage } from "./shared";
import type { ObsEnv } from "./types";

/** 受け付ける本文の上限 (バイト) */
export const MAX_BODY_BYTES = 256_000;

interface Intake {
  /** 記録に出す route 名 (パスのトークンは含めない) */
  route: string;
  /** 変換に失敗したときに記録へ出すステップ名 (n8n のノード名) */
  step: string;
  /** 本文 → obs-notify の payload (配列) */
  convert: (body: unknown) => unknown[];
  /** 変換前に件数を切り詰める (切り捨てた件数を返す) */
  cap?: (body: unknown) => { body: unknown; dropped: number };
  /** 合言葉を読むヘッダ */
  authHeader: string;
  secret: (env: ObsEnv) => string | undefined;
  /** パス末尾のトークンを受けるか (webhook にヘッダを付けられない Sentry だけ) */
  allowPathToken: boolean;
  /** 応答の形 (n8n の api/obs-notify と同じ / n8n の adapter と同じ) */
  respond: (results: ObsNotifyResponse[], dropped: number) => Response;
}

const OBS_NOTIFY: Intake = {
  route: "/obs-notify",
  step: "PrepNotify",
  convert: (body) => [body],
  authHeader: "X-Webhook-Secret",
  secret: (env) => env.WEBHOOK_SECRET,
  allowPathToken: false,
  respond: (results) => Response.json(results[0]),
};

/** n8n の adapter と同じく success:true / forwarded:true。Notion に書けたかは件数で返す */
function adapterResponse(results: ObsNotifyResponse[], dropped: number): Response {
  const written = results.filter((r) => r.notion.ok).length;
  const queued = results.filter((r) => !r.notion.ok && r.notion.queued).length;
  return Response.json({
    success: true,
    forwarded: true,
    items: results.length,
    written,
    queued,
    failed: results.length - written - queued,
    dropped,
  });
}

function obsFrom(
  name: string,
  step: string,
  convert: Intake["convert"],
  overrides: Partial<Intake> = {},
): [string, Intake] {
  return [
    name,
    {
      route: `/obs-from/${name}`,
      step,
      convert,
      authHeader: "X-Adapter-Token",
      secret: (env) => env.ADAPTER_TOKEN,
      allowPathToken: false,
      respond: adapterResponse,
      ...overrides,
    },
  ];
}

/** name → 受け口。Map で引く (オブジェクトだと "constructor" 等のプロトタイプのキーに当たる) */
const OBS_FROM: ReadonlyMap<string, Intake> = new Map([
  obsFrom("sentry", "ConvertSentry", convertSentry, {
    secret: (env) => env.SENTRY_ADAPTER_TOKEN,
    allowPathToken: true,
  }),
  obsFrom("healthchecks", "ConvertHealthchecks", convertHealthchecks),
  obsFrom("grafana", "ConvertGrafana", convertGrafana, { cap: capGrafanaAlerts }),
  obsFrom("netdata", "ConvertNetdata", convertNetdata),
]);

const OBS_FROM_RE = /^\/obs-from\/([^/]+)(?:\/([^/]+))?\/?$/;

/** /obs-notify・/obs-from/* なら処理して Response を返す。対象外のパスは null */
export async function routeObsRequest(
  request: Request,
  env: ObsEnv,
  ctx: ExecutionContext,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/obs-notify") {
    return intake(request, env, ctx, OBS_NOTIFY, undefined);
  }
  const m = pathname.match(OBS_FROM_RE);
  if (!m) return null;
  const target = OBS_FROM.get(m[1]);
  if (!target) return new Response("not found", { status: 404 });
  return intake(request, env, ctx, target, m[2]);
}

async function intake(
  request: Request,
  env: ObsEnv,
  ctx: ExecutionContext,
  target: Intake,
  pathToken: string | undefined,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!(await authorized(request, env, target, pathToken))) return forbidden();
  if (!env.NOTION_TOKEN) return notConfigured();

  const text = await readLimitedText(request);
  if (text === null) {
    return reject(
      env,
      ctx,
      target.route,
      "ReadBody",
      `request body exceeds ${MAX_BODY_BYTES} bytes`,
      { content_length: request.headers.get("Content-Length") },
      413,
    );
  }
  const raw = text.slice(0, 2000);
  const parsed = parseBody(text, request);
  if (!parsed.ok) {
    return reject(env, ctx, target.route, "ParseBody", "request body is not valid JSON", raw);
  }

  const capped = target.cap
    ? target.cap(parsed.body)
    : { body: parsed.body, dropped: 0 };
  if (capped.dropped > 0) {
    console.log(
      JSON.stringify({
        type: "obs_adapter_items_dropped",
        route: target.route,
        dropped: capped.dropped,
      }),
    );
  }

  let payloads: unknown[];
  try {
    payloads = target.convert(capped.body);
  } catch (e) {
    return reject(env, ctx, target.route, target.step, errorMessage(e), raw);
  }
  let prepared: PreparedNotify[];
  try {
    prepared = prepareAll(env, payloads);
  } catch (e) {
    return reject(env, ctx, target.route, "PrepNotify", errorMessage(e), raw);
  }

  const results = await runToCompletion(
    ctx,
    deliverPrepared(env, prepared, new InvocationBudget()),
  );
  return target.respond(results, capped.dropped);
}

/** パス末尾のトークンは allowPathToken の受け口だけ。それ以外で付いていたら 403 */
async function authorized(
  request: Request,
  env: ObsEnv,
  target: Intake,
  pathToken: string | undefined,
): Promise<boolean> {
  if (pathToken !== undefined && !target.allowPathToken) return false;
  return matchesSecret(
    [request.headers.get(target.authHeader), decodeSegment(pathToken)],
    target.secret(env),
  );
}

/** 受け付けられなかった payload を warning で記録してからエラー応答を返す */
async function reject(
  env: ObsEnv,
  ctx: ExecutionContext,
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

/**
 * 本文を上限付きで読む。上限を超えたら null。
 * Content-Length があればそれで判断し、無ければストリームで読みながら数える。
 */
async function readLimitedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (Number.isFinite(declared)) {
    return declared > MAX_BODY_BYTES ? null : request.text();
  }
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
  return new Blob(chunks).text();
}

type ParsedBody = { ok: true; body: unknown } | { ok: false };

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
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** 応答を待つ間に送り元が切断しても処理を打ち切られないよう waitUntil にも渡す */
function runToCompletion<T>(ctx: ExecutionContext, work: Promise<T>): Promise<T> {
  // 失敗は戻り値の Promise 側で呼び出し元に伝わる。waitUntil 側では二重に投げない
  ctx.waitUntil(work.then(() => undefined, () => undefined));
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
