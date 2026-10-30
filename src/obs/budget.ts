/**
 * 1 回の Worker 呼び出し (invocation) で使える外部呼び出しの枠と時間。
 *
 * Workers Free の制約に収めるための上限:
 * - 外部への subrequest は 1 invocation 50 まで → Notion 20 + Discord 10 = 最大 30
 *   (KV・Queue は Cloudflare 内部サービスの枠 1,000 で別勘定。Queue の sendBatch は最大 5 回)
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

export type BudgetKind = "write" | "notion" | "discord" | "queue";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InvocationBudget {
  readonly deadline: number;
  private readonly left: Record<BudgetKind, number> = {
    write: MAX_DIRECT_WRITES,
    notion: MAX_NOTION_CALLS,
    discord: MAX_DISCORD_CALLS,
    queue: MAX_QUEUE_CALLS,
  };
  /** 再試行を使い切った書き込みがあった = Notion が落ちている。以降は呼ばずに Queue に回す */
  private notionDown = false;
  private nextNotionAt = 0;

  constructor(budgetMs = PROCESS_BUDGET_MS) {
    this.deadline = Date.now() + budgetMs;
  }

  /** waitMs 待ってから HTTP を 1 回呼んでも締め切りに間に合うか */
  hasTimeFor(waitMs: number): boolean {
    return Date.now() + waitMs + HTTP_TIMEOUT_MS <= this.deadline;
  }

  /**
   * kind の枠を 1 つ取る。尽きていれば false。
   * Discord は応答を締め切りまでに待ち切れないときも false。
   */
  take(kind: BudgetKind): boolean {
    if (this.left[kind] <= 0) return false;
    if (kind === "discord" && !this.hasTimeFor(0)) return false;
    this.left[kind]--;
    return true;
  }

  /** Notion の再試行を使い切った。この invocation では以降 Notion を呼ばない */
  reportNotionFailure(): void {
    this.notionDown = true;
  }

  /**
   * Notion 呼び出し 1 回分の枠を取り、前回の呼び出しから 350ms 空くまで待つ。
   * Notion 停止中・枠が尽きた・締め切りに間に合わないときは false (呼び出さずに Queue に回す)。
   * 並行して呼ばれても開始時刻を同期的に予約するので間隔は保たれる。
   */
  async acquireNotionCall(): Promise<boolean> {
    if (this.notionDown) return false;
    const now = Date.now();
    const startAt = Math.max(now, this.nextNotionAt);
    if (startAt + HTTP_TIMEOUT_MS > this.deadline) return false;
    if (!this.take("notion")) return false;
    this.nextNotionAt = startAt + NOTION_GAP_MS;
    if (startAt > now) await sleep(startAt - now);
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
