/**
 * obs-notify の処理本体 (n8n の api/obs-notify WF と同じ流れ):
 *   検証 (prepNotify) → critical なら Discord → Notion 観測性 DB に書き込み → 応答 (formatResponse)
 *
 * n8n との違い:
 * - Discord に送れなかったときは Notion の discord_channel を空にする (送っていない記録を
 *   「送った」と読ませない)。n8n の api/obs-notify は送信を試みた時点で discord_channel を入れる。
 * - 同じ critical (severity + service + subject) は 60 秒に 1 回だけ Discord に送る。
 * - Notion に書けなかった分 (再試行を使い切った / 1 回の上限を超えた) は OBS_RETRY_QUEUE に積み、
 *   queue() ハンドラ (consumeRetryBatch) が後から書き込む。
 */
import { InvocationBudget } from "./budget";
import { isDiscordOk, sendDiscord } from "./discord";
import { formatResponse, type ObsNotifyResponse } from "./formatResponse";
import {
  createNotionPage,
  notAttempted,
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
import { claimOnce, errorMessage, release, sha256Hex } from "./shared";
import type { JsonObject, ObsEnv, ObsRetryMessage } from "./types";

/** Queue に積むときの配信遅延・consumer の再試行間隔 */
export const QUEUE_RETRY_DELAY_SEC = 30;
/**
 * consumer が再送をあきらめるまでの回数。ここが決める
 * (wrangler.toml の max_retries はこれより大きくした安全網)。
 */
export const QUEUE_MAX_RETRIES = 5;
/** Queues の delaySeconds の上限 (12 時間) */
const QUEUE_MAX_DELAY_SEC = 43_200;
/** sendBatch 1 回の上限 (Queues: 100 件 / 256KB) に余裕を持たせた値 */
const QUEUE_BATCH_MAX_MESSAGES = 100;
const QUEUE_BATCH_MAX_BYTES = 200_000;
/** consumer は wall time に余裕がある (15 分) ので締め切りを長めにとる */
const CONSUMER_BUDGET_MS = 300_000;

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
    const { discordRes, deduplicated } = prep.sendDiscordNow
      ? await notifyDiscord(env, prep, budget)
      : { discordRes: null, deduplicated: false };
    const notionBody = isDiscordOk(discordRes)
      ? prep.notionBody
      : withoutDiscordChannel(prep.notionBody);

    // 2) Notion に書き込む。上限超過・Notion 停止中は試さずに Queue へ回す
    let result: NotionWriteResult;
    if (!env.NOTION_TOKEN) {
      result = notAttempted("NOTION_TOKEN not configured", false);
    } else if (!budget.take("write")) {
      result = notAttempted("deferred to retry queue", true);
    } else {
      result = await writeNotionWithRetry(env.NOTION_TOKEN, notionBody, budget);
      if (!result.ok && result.retryable && result.attempts > 0) {
        budget.reportNotionFailure();
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

/** 検証 + 送信。tail 経路から直接呼ぶ */
export async function processPayloads(
  env: ObsEnv,
  payloads: unknown[],
  budget: InvocationBudget = new InvocationBudget(),
): Promise<ObsNotifyResponse[]> {
  return deliverPrepared(env, prepareAll(env, payloads), budget);
}

/**
 * 受け付けられなかった payload の記録 (n8n では WF の失敗が system/error-handler 経由で
 * 観測性 DB に warning として残る。それに相当する)。
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

/**
 * critical を Discord に送る。60 秒以内に同じものを送っていれば鳴らさない。
 * 重複抑制の KV が失敗しても通知は止めない (重複抑制なしで送る)。
 */
async function notifyDiscord(
  env: ObsEnv,
  prep: PreparedNotify,
  budget: InvocationBudget,
): Promise<{ discordRes: JsonObject | null; deduplicated: boolean }> {
  const kv = env.DEDUP_KV;
  const key = kv
    ? `critical:${await sha256Hex(`${prep.severity}\n${prep.service}\n${prep.subject}`, 16)}`
    : null;
  const claimed = kv && key ? await kvOrFallback(() => claimOnce(kv, key), true) : true;
  if (!claimed) return { discordRes: null, deduplicated: true };

  const discordRes = budget.take("discord")
    ? await sendDiscord(prep.discordUrl, prep.discordBody)
    : { error: "discord call budget exhausted" };
  // 送れなかったら印を消し、次に来た同じアラートで送り直せるようにする
  if (kv && key && !isDiscordOk(discordRes)) {
    await kvOrFallback(() => release(kv, key), undefined);
  }
  return { discordRes, deduplicated: false };
}

/** critical の重複抑制の KV 操作。KV が使えなければ fallback で進める */
async function kvOrFallback<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (e) {
    const error = errorMessage(e);
    console.log(JSON.stringify({ type: "obs_critical_dedup_kv_error", error }));
    return fallback;
  }
}

function withoutDiscordChannel(body: NotionPageBody): NotionPageBody {
  if (!("discord_channel" in body.properties)) return body;
  const properties = { ...body.properties };
  delete properties.discord_channel;
  return { ...body, properties };
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

  // sendBatch の件数・サイズ上限に合わせて分割する。1 件の大きさはプロパティの文字数制限で
  // 数十 KB 以内に収まる (Queues の 1 メッセージ上限 128KB に届かない)
  const encoder = new TextEncoder();
  const chunks: { state: DeliveryState; req: MessageSendRequest<ObsRetryMessage> }[][] = [];
  let current: (typeof chunks)[number] = [];
  let currentBytes = 0;
  for (const state of pending) {
    const body: ObsRetryMessage = {
      properties: state.notionBody.properties,
      subject: state.prep.subject.slice(0, 200),
    };
    const bytes = encoder.encode(JSON.stringify(body)).byteLength;
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
    if (!budget.take("queue")) {
      console.log(
        JSON.stringify({ type: "obs_retry_queue_budget_exhausted", dropped: chunk.length }),
      );
      break;
    }
    try {
      await queue.sendBatch(chunk.map((c) => c.req));
      for (const c of chunk) c.state.queued = true;
    } catch (e) {
      // 積めなかった分は queued にならず、応答で「書けなかった」と返る
      const error = errorMessage(e);
      console.log(
        JSON.stringify({ type: "obs_retry_enqueue_failed", count: chunk.length, error }),
      );
    }
  }
}

/**
 * 再送キューの consumer。1 メッセージにつき Notion を 1 回だけ呼び、
 * 成功 → ack / 429・5xx → 30 秒後に retry / それ以外の失敗 → 記録して ack。
 * QUEUE_MAX_RETRIES 回再送しても書けなければ、ログに残して ack する。
 * 書き込み先は常に観測性 DB (メッセージは properties だけを持つ)。
 */
export async function consumeRetryBatch(
  batch: MessageBatch<unknown>,
  env: ObsEnv,
): Promise<void> {
  const budget = new InvocationBudget(CONSUMER_BUDGET_MS);
  for (const msg of batch.messages) {
    const body = msg.body as Partial<ObsRetryMessage> | null;
    const properties = body?.properties;
    if (typeof properties !== "object" || properties === null) {
      console.log(JSON.stringify({ type: "obs_retry_invalid_message", id: msg.id }));
      msg.ack();
      continue;
    }
    const subject = body?.subject ?? "";
    if (!env.NOTION_TOKEN || !(await budget.acquireNotionCall())) {
      retryOrGiveUp(msg, { id: msg.id, subject, status: null, message: "not attempted" });
      continue;
    }
    const r = await createNotionPage(env.NOTION_TOKEN, {
      parent: { database_id: OBS_DB_ID },
      properties,
    });
    if (r.ok) {
      msg.ack();
      continue;
    }
    const log = { id: msg.id, subject, status: r.status, message: r.message.slice(0, 300) };
    if (!r.retryable) {
      console.log(JSON.stringify({ type: "obs_retry_dropped", attempts: msg.attempts, ...log }));
      msg.ack();
    } else {
      retryOrGiveUp(msg, log, r.retryAfterSec);
    }
  }
}

function retryOrGiveUp(
  msg: Message<unknown>,
  log: JsonObject,
  retryAfterSec?: number,
): void {
  if (msg.attempts > QUEUE_MAX_RETRIES) {
    console.log(JSON.stringify({ type: "obs_retry_giveup", attempts: msg.attempts, ...log }));
    msg.ack();
  } else {
    msg.retry({ delaySeconds: retryDelaySeconds(retryAfterSec) });
  }
}
