/**
 * obs-notify の処理本体 (n8n の api/obs-notify WF と同じ流れ):
 *   検証 (prepNotify) → critical なら Discord → Notion 観測性 DB に書き込み → 応答 (formatResponse)
 *
 * n8n との違い:
 * - Discord に送れなかったときは Notion の discord_channel を空にする (送っていない記録を
 *   「送った」と読ませない)。n8n の api/obs-notify は送信を試みた時点で discord_channel を入れる。
 * - Notion に書けなかった分 (再試行を使い切った / 1 回の上限を超えた) は OBS_RETRY_QUEUE に積み、
 *   queue() ハンドラ (consumeRetryBatch) が後から書き込む。
 */
import { InvocationBudget } from "./budget";
import { isDiscordOk, sendDiscord } from "./discord";
import { formatResponse, type ObsNotifyResponse } from "./formatResponse";
import {
  createNotionPage,
  type NotionWriteResult,
  writeNotionWithRetry,
} from "./notion";
import { type ObsNotifyPayload, obsNotifyFromCron } from "./obsNotifyPayload";
import {
  type NotionPageBody,
  OBS_DB_ID,
  type PreparedNotify,
  prepNotify,
} from "./prepNotify";
import type { JsonObject, ObsEnv, ObsRetryMessage } from "./types";

/** Queue に積むときの配信遅延・consumer の再試行間隔 */
export const QUEUE_RETRY_DELAY_SEC = 30;
/** wrangler.toml の [[queues.consumers]] max_retries と同じ値にする */
export const QUEUE_MAX_RETRIES = 5;
/** Queues の delaySeconds の上限 (12 時間) */
const QUEUE_MAX_DELAY_SEC = 43_200;
/** sendBatch 1 回の上限 (Queues: 100 件 / 256KB) に余裕を持たせた値 */
const QUEUE_BATCH_MAX_MESSAGES = 100;
const QUEUE_BATCH_MAX_BYTES = 200_000;
/** 1 メッセージの上限 (Queues: 128KB) に余裕を持たせた値 */
const QUEUE_MESSAGE_MAX_BYTES = 120_000;
/** consumer は wall time に余裕がある (15 分) ので締め切りを長めにとる */
const CONSUMER_BUDGET_MS = 300_000;
/** 同じ critical を Discord に再送しない時間 (tail の重複抑制と同じ 60 秒) */
const CRITICAL_DEDUP_TTL_SEC = 60;

interface DeliveryState {
  prep: PreparedNotify;
  discordRes: JsonObject | null;
  /** 同じ critical を直前に送っていたので Discord を鳴らさなかった */
  deduplicated: boolean;
  notionBody: NotionPageBody;
  result: NotionWriteResult;
  queued: boolean;
}

/**
 * payload を全件検証する。1 件でも不正なら ObsPayloadError を投げる
 * (副作用の前に検証を済ませ、半端に書き込まない)。
 */
export function prepareAll(env: ObsEnv, payloads: unknown[]): PreparedNotify[] {
  return payloads.map((p) =>
    prepNotify(p, { discordCriticalUrl: env.DISCORD_CRITICAL_URL }),
  );
}

/** 検証済みのイベントを Discord / Notion に送る。件数分の応答を返す */
export async function deliverPrepared(
  env: ObsEnv,
  prepared: PreparedNotify[],
  budget: InvocationBudget,
): Promise<ObsNotifyResponse[]> {
  const states: DeliveryState[] = [];

  for (const prep of prepared) {
    // 1) critical は Discord へ即時送信。失敗しても Notion への記録は続ける
    let discordRes: JsonObject | null = null;
    let deduplicated = false;
    if (prep.sendDiscordNow) {
      const dedupKey = env.DEDUP_KV ? await criticalDedupKey(prep) : null;
      if (dedupKey && (await kvOrFallback(() => env.DEDUP_KV!.get(dedupKey), null)) !== null) {
        // 60 秒以内に同じ critical を送っている → Discord は鳴らさず Notion にだけ記録する
        deduplicated = true;
      } else if (budget.takeDiscordCall()) {
        if (dedupKey) {
          await kvOrFallback(
            () => env.DEDUP_KV!.put(dedupKey, "1", { expirationTtl: CRITICAL_DEDUP_TTL_SEC }),
            undefined,
          );
        }
        discordRes = await sendDiscord(prep.discordUrl, prep.discordBody);
        // 送れなかったら印を消し、次に来た同じアラートで送り直せるようにする
        if (dedupKey && !isDiscordOk(discordRes)) {
          await kvOrFallback(() => env.DEDUP_KV!.delete(dedupKey), undefined);
        }
      } else {
        discordRes = { error: "discord call budget exhausted" };
      }
    }
    const notionBody = isDiscordOk(discordRes)
      ? prep.notionBody
      : withoutDiscordChannel(prep.notionBody);

    // 2) Notion に書き込む。上限超過・Notion 停止中は試さずに Queue へ回す
    let result: NotionWriteResult;
    if (!env.NOTION_TOKEN) {
      result = {
        ok: false,
        status: null,
        message: "NOTION_TOKEN not configured",
        retryable: false,
        attempts: 0,
      };
    } else if (budget.notionDown || !budget.takeWrite()) {
      result = {
        ok: false,
        status: null,
        message: "deferred to retry queue",
        retryable: true,
        attempts: 0,
      };
    } else {
      result = await writeNotionWithRetry(env.NOTION_TOKEN, notionBody, budget);
      if (!result.ok && result.retryable && result.attempts > 0) {
        budget.notionDown = true;
      }
    }
    if (!result.ok) {
      console.log(
        JSON.stringify({
          type: "obs_notion_write_failed",
          subject: prep.subject.slice(0, 200),
          status: result.status,
          attempts: result.attempts,
          message: result.message.slice(0, 300),
        }),
      );
    }
    states.push({ prep, discordRes, deduplicated, notionBody, result, queued: false });
  }

  // 3) 書けなかった分を再送キューへ
  await enqueueRetries(
    env,
    budget,
    states.filter((s) => !s.result.ok && s.result.retryable),
  );

  return states.map(toResponse);
}

/** 検証 + 送信。maybeNotify (tail 経路) から直接呼ぶ */
export async function processPayloads(
  env: ObsEnv,
  payloads: unknown[],
  budget: InvocationBudget = new InvocationBudget(),
): Promise<ObsNotifyResponse[]> {
  return deliverPrepared(env, prepareAll(env, payloads), budget);
}

/**
 * 受け付けられなかった payload の記録 (n8n では WF の失敗が system/error-handler 経由で
 * 観測性 DB に warning として残っていた。それに相当する)。
 */
export function rejectionPayload(
  route: string,
  step: string,
  message: string,
  raw: unknown,
): ObsNotifyPayload {
  return obsNotifyFromCron({
    label: `obs-intake エラー (${route})`,
    isError: true,
    detail: `[${step}] ${message}`,
    service: "observability-tail",
    repo: "observability-tail",
    severity: "warning",
    raw_payload: raw,
  });
}

function withoutDiscordChannel(body: NotionPageBody): NotionPageBody {
  if (!("discord_channel" in body.properties)) return body;
  const properties = { ...body.properties };
  delete properties.discord_channel;
  return { ...body, properties };
}

function isObservabilityDbBody(notionBody: unknown): notionBody is JsonObject {
  if (typeof notionBody !== "object" || notionBody === null) return false;
  const parent = (notionBody as JsonObject).parent as JsonObject | undefined;
  return parent?.database_id === OBS_DB_ID;
}

/** severity + service + subject が同じ critical を同じアラートとみなす */
async function criticalDedupKey(prep: PreparedNotify): Promise<string> {
  const source = `${prep.severity}\n${prep.service}\n${prep.subject}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = Array.from(new Uint8Array(buf).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `critical:${hex}`;
}

/**
 * 重複抑制の KV 操作。KV が失敗しても critical の通知は止めない
 * (重複抑制なしで送る方を選ぶ) ので、失敗はログに残して fallback を返す。
 */
async function kvOrFallback<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (e) {
    console.log(
      JSON.stringify({
        type: "obs_critical_dedup_kv_error",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return fallback;
  }
}

function toResponse(s: DeliveryState): ObsNotifyResponse {
  // n8n の CreateNotionPage と同じ形にそろえる: 成功ならページ、失敗なら { error: { httpCode } }
  const notionJson: JsonObject = s.result.ok
    ? (s.result.page ?? {})
    : {
        error: {
          httpCode: s.result.status === null ? undefined : String(s.result.status),
          message: s.result.message,
        },
      };
  const res = formatResponse(s.prep, s.discordRes, notionJson);
  if (s.deduplicated) {
    // 直前に同じ通知が届いているので Discord 側は成功扱い
    res.discord = { ok: true, status: null, skipped: true, deduplicated: true };
    res.success = res.notion.ok;
  }
  if (s.queued) res.notion.queued = true;
  return res;
}

function retryDelaySeconds(retryAfterSec: number | undefined): number {
  return Math.min(
    Math.max(QUEUE_RETRY_DELAY_SEC, Math.ceil(retryAfterSec ?? 0)),
    QUEUE_MAX_DELAY_SEC,
  );
}

async function enqueueRetries(
  env: ObsEnv,
  budget: InvocationBudget,
  pending: DeliveryState[],
): Promise<void> {
  const queue = env.OBS_RETRY_QUEUE;
  if (!queue || pending.length === 0) return;

  // sendBatch の件数・サイズ上限に合わせて分割する
  const encoder = new TextEncoder();
  const chunks: { state: DeliveryState; req: MessageSendRequest<ObsRetryMessage> }[][] = [];
  let current: (typeof chunks)[number] = [];
  let currentBytes = 0;
  for (const state of pending) {
    const body: ObsRetryMessage = {
      notionBody: state.notionBody,
      subject: state.prep.subject.slice(0, 200),
    };
    const bytes = encoder.encode(JSON.stringify(body)).byteLength;
    if (bytes > QUEUE_MESSAGE_MAX_BYTES) {
      console.log(
        JSON.stringify({ type: "obs_retry_too_large", subject: body.subject, bytes }),
      );
      continue;
    }
    if (
      current.length >= QUEUE_BATCH_MAX_MESSAGES ||
      currentBytes + bytes > QUEUE_BATCH_MAX_BYTES
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({
      state,
      req: { body, delaySeconds: retryDelaySeconds(state.result.retryAfterSec) },
    });
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);

  for (const chunk of chunks) {
    if (!budget.takeQueueCall()) {
      console.log(
        JSON.stringify({ type: "obs_retry_queue_budget_exhausted", dropped: chunk.length }),
      );
      break;
    }
    try {
      await queue.sendBatch(chunk.map((c) => c.req));
      for (const c of chunk) c.state.queued = true;
    } catch (e) {
      console.log(
        JSON.stringify({
          type: "obs_retry_enqueue_failed",
          count: chunk.length,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
}

/**
 * 再送キューの consumer。1 メッセージにつき Notion を 1 回だけ呼び、
 * 成功 → ack / 429・5xx → 30 秒後に retry / それ以外の失敗 → 記録して ack。
 * max_retries を使い切った配信で失敗したら、ログに残して ack する (以降は再送されない)。
 */
export async function consumeRetryBatch(
  batch: MessageBatch<unknown>,
  env: ObsEnv,
): Promise<void> {
  const budget = new InvocationBudget({ budgetMs: CONSUMER_BUDGET_MS });
  for (const msg of batch.messages) {
    const body = msg.body as Partial<ObsRetryMessage> | null;
    // 書き込み先は観測性 DB だけ。それ以外を指すメッセージは書かずに捨てる
    if (!body || !isObservabilityDbBody(body.notionBody)) {
      console.log(JSON.stringify({ type: "obs_retry_invalid_message", id: msg.id }));
      msg.ack();
      continue;
    }
    if (!env.NOTION_TOKEN || !(await budget.acquireNotionCall())) {
      msg.retry({ delaySeconds: QUEUE_RETRY_DELAY_SEC });
      continue;
    }
    const r = await createNotionPage(env.NOTION_TOKEN, body.notionBody);
    if (r.ok) {
      msg.ack();
      continue;
    }
    const logBase = {
      id: msg.id,
      subject: body.subject ?? "",
      status: r.status,
      attempts: msg.attempts,
      message: r.message.slice(0, 300),
    };
    if (!r.retryable) {
      console.log(JSON.stringify({ type: "obs_retry_dropped", ...logBase }));
      msg.ack();
    } else if (msg.attempts > QUEUE_MAX_RETRIES) {
      console.log(JSON.stringify({ type: "obs_retry_giveup", ...logBase }));
      msg.ack();
    } else {
      msg.retry({ delaySeconds: retryDelaySeconds(r.retryAfterSec) });
    }
  }
}
