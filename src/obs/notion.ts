/**
 * Notion 観測性 DB へのページ作成。
 * n8n の CreateNotionPage と同じく最大 3 回・2 秒間隔で試す。ただし再試行するのは
 * 一時的な失敗 (429 / 5xx / 通信エラー・タイムアウト) だけ。400 等は何度送っても通らない。
 * 500 でも書き込みが反映されている場合の重複記録は許容する (n8n 側と同じ判断)。
 */
import {
  type InvocationBudget,
  fetchWithTimeout,
  sleep,
} from "./budget";
import { errorMessage } from "./shared";
import type { JsonObject } from "./types";

export const NOTION_PAGES_URL = "https://api.notion.com/v1/pages";
export const NOTION_VERSION = "2022-06-28";
export const NOTION_MAX_ATTEMPTS = 3;
export const NOTION_RETRY_WAIT_MS = 2_000;
/** Retry-After はこの長さまで待つ。これより長ければ待たずに Queue に回す */
export const NOTION_MAX_RETRY_AFTER_MS = 10_000;

export interface NotionAttempt {
  ok: boolean;
  /** HTTP ステータス。通信エラー・タイムアウト・未実行は null */
  status: number | null;
  /** 成功時の Notion ページ (id を含む) */
  page?: JsonObject;
  message: string;
  /** 時間をおけば通る見込みがある (429 / 5xx / 通信エラー) */
  retryable: boolean;
  /** Retry-After ヘッダ (秒) */
  retryAfterSec?: number;
}

export interface NotionWriteResult extends NotionAttempt {
  /** 実際に Notion を呼んだ回数 */
  attempts: number;
}

/** Notion を呼ばなかったときの結果 (設定漏れ・上限超過・Notion 停止中) */
export function notAttempted(message: string, retryable: boolean): NotionWriteResult {
  return { ok: false, status: null, message, retryable, attempts: 0 };
}

/** Retry-After (秒数 or HTTP-date) を秒に直す。解釈できなければ undefined */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** Notion にページを 1 回作成する (再試行なし。Queue の consumer からも使う) */
export async function createNotionPage(
  token: string,
  body: JsonObject,
): Promise<NotionAttempt> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(NOTION_PAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      status: null,
      message: errorMessage(e),
      retryable: true,
    };
  }

  const text = await resp.text().catch(() => "");
  let json: JsonObject = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object") json = parsed as JsonObject;
  } catch {
    // Notion の 5xx は HTML のことがある。本文は使わない
  }

  if (resp.ok) {
    return { ok: true, status: resp.status, page: json, message: "ok", retryable: false };
  }
  const retryable = resp.status === 429 || resp.status >= 500;
  return {
    ok: false,
    status: resp.status,
    message:
      typeof json.message === "string"
        ? json.message
        : `HTTP ${resp.status}`,
    retryable,
    retryAfterSec: parseRetryAfter(resp.headers.get("Retry-After")),
  };
}

/**
 * 最大 3 回まで再試行して書き込む。枠・時間が足りないときは途中でやめて
 * retryable=true のまま返す (呼び出し側が Queue に回す)。
 */
export async function writeNotionWithRetry(
  token: string,
  body: JsonObject,
  budget: InvocationBudget,
): Promise<NotionWriteResult> {
  let attempts = 0;
  let last: NotionAttempt = notAttempted(
    "not attempted (notion budget / deadline exhausted or Notion down)",
    true,
  );

  while (attempts < NOTION_MAX_ATTEMPTS) {
    if (attempts > 0) {
      // 再試行の待ち: Retry-After があればそれ (2 秒未満なら 2 秒)、なければ 2 秒
      const retryAfterMs = (last.retryAfterSec ?? 0) * 1000;
      if (retryAfterMs > NOTION_MAX_RETRY_AFTER_MS) break;
      const waitMs = Math.max(NOTION_RETRY_WAIT_MS, retryAfterMs);
      if (!budget.hasTimeFor(waitMs)) break;
      await sleep(waitMs);
    }
    if (!(await budget.acquireNotionCall())) break;
    attempts++;
    last = await createNotionPage(token, body);
    if (last.ok || !last.retryable) break;
  }

  return { ...last, attempts };
}
