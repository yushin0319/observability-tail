/**
 * 1 回の Worker 呼び出し (invocation) で使える外部呼び出しの枠と時間。
 *
 * Workers Free の制約に収めるための上限:
 * - subrequest は 1 invocation 50 まで → Notion 20 + Discord 10 + Queue 5 = 最大 35
 * - クライアント切断後に waitUntil で延長できるのは 30 秒まで → 処理全体を 20 秒以内に終える
 * Notion の平均レート制限 (3 req/s) に合わせ、Notion 呼び出しの開始間隔を 350ms 以上空ける。
 */

/** Notion に直接書く件数の上限。超えた分は Queue に回す */
export const MAX_DIRECT_WRITES = 10;
/** Notion API 呼び出し (再試行を含む) の上限 */
export const MAX_NOTION_CALLS = 20;
/** Discord webhook 呼び出しの上限 */
export const MAX_DISCORD_CALLS = 10;
/** Queue への sendBatch 呼び出しの上限 */
export const MAX_QUEUE_CALLS = 5;
/** Notion 呼び出しの開始間隔 */
export const NOTION_GAP_MS = 350;
/** 1 回の HTTP 呼び出しのタイムアウト (n8n の HTTP ノードと同じ 10 秒) */
export const HTTP_TIMEOUT_MS = 10_000;
/** fetch / tail 経路で処理全体にかけてよい時間 */
export const PROCESS_BUDGET_MS = 20_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BudgetOptions {
  /** 処理全体にかけてよい時間 (既定 PROCESS_BUDGET_MS) */
  budgetMs?: number;
}

export class InvocationBudget {
  writesLeft = MAX_DIRECT_WRITES;
  notionCallsLeft = MAX_NOTION_CALLS;
  discordCallsLeft = MAX_DISCORD_CALLS;
  queueCallsLeft = MAX_QUEUE_CALLS;
  /** 再試行を使い切った書き込みがあった = Notion が落ちている。以降は試さず Queue に回す */
  notionDown = false;
  readonly deadline: number;
  private nextNotionAt = 0;

  constructor(opts: BudgetOptions = {}) {
    this.deadline = Date.now() + (opts.budgetMs ?? PROCESS_BUDGET_MS);
  }

  /** waitMs 待ってから Notion を 1 回呼んでも締め切りに間に合うか */
  hasTimeFor(waitMs: number): boolean {
    return Date.now() + waitMs + HTTP_TIMEOUT_MS <= this.deadline;
  }

  /**
   * Notion 呼び出し 1 回分の枠を取り、前回の呼び出しから 350ms 空くまで待つ。
   * 枠が尽きた / 締め切りに間に合わないときは false (呼び出さずに Queue に回す)。
   * 並行して呼ばれても (tail 経路) 開始時刻を同期的に予約するので間隔は保たれる。
   */
  async acquireNotionCall(): Promise<boolean> {
    if (this.notionCallsLeft <= 0) return false;
    const now = Date.now();
    const startAt = Math.max(now, this.nextNotionAt);
    if (startAt + HTTP_TIMEOUT_MS > this.deadline) return false;
    this.notionCallsLeft--;
    this.nextNotionAt = startAt + NOTION_GAP_MS;
    if (startAt > now) await sleep(startAt - now);
    return true;
  }

  /** 直接書き込みの枠を 1 件取る */
  takeWrite(): boolean {
    if (this.writesLeft <= 0) return false;
    this.writesLeft--;
    return true;
  }

  /** Discord 呼び出し 1 回分の枠を取る。締め切りまでに応答を待ち切れないときも false */
  takeDiscordCall(): boolean {
    if (this.discordCallsLeft <= 0 || !this.hasTimeFor(0)) return false;
    this.discordCallsLeft--;
    return true;
  }

  takeQueueCall(): boolean {
    if (this.queueCallsLeft <= 0) return false;
    this.queueCallsLeft--;
    return true;
  }
}

/** タイムアウト付き fetch。時間切れは AbortError で reject する */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
