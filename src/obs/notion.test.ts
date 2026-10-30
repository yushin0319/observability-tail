/**
 * Notion 書き込みの再試行 (最大 3 回 / 2 秒間隔 / Retry-After は 10 秒まで / 1 回 10 秒で打ち切り)。
 * 外部 HTTP (fetch) だけ偽物にし、待ち時間は fake timers で進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvocationBudget } from "./budget";
import { NOTION_PAGES_URL, parseRetryAfter, writeNotionWithRetry } from "./notion";
import {
  notionError,
  notionPage,
  settle,
  stubFetch,
  useFakeClock,
} from "./test-helpers";

const BODY = { parent: { database_id: "db" }, properties: {} };


describe("parseRetryAfter", () => {
  it("秒数をそのまま返す", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(" 1.5 ")).toBe(1.5);
  });

  it("HTTP-date は現在時刻との差 (秒、切り上げ)", () => {
    const now = Date.parse("2026-10-30T00:00:00Z");
    expect(parseRetryAfter("Fri, 30 Oct 2026 00:00:12 GMT", now)).toBe(12);
  });

  it("無い / 解釈できないときは undefined", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("writeNotionWithRetry", () => {
  beforeEach(() => {
    useFakeClock();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("Notion API に Bearer token / Notion-Version 2022-06-28 で POST する", async () => {
    const { notionCalls } = stubFetch();
    const r = await settle(writeNotionWithRetry("secret-token", BODY, new InvocationBudget()));
    expect(r.ok).toBe(true);
    expect(r.page).toEqual({ object: "page", id: "page-1" });
    expect(notionCalls).toHaveLength(1);
    const headers = notionCalls[0].init.headers as Record<string, string>;
    expect(notionCalls[0].url).toBe(NOTION_PAGES_URL);
    expect(notionCalls[0].init.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    expect(notionCalls[0].json).toEqual(BODY);
  });

  it("5xx → 5xx → 成功: 2 秒おきに 3 回目で書ける", async () => {
    const { notionCalls } = stubFetch({
      notion: (_c, n) => (n < 3 ? notionError(503) : notionPage("p3")),
    });
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(notionCalls[1].at - notionCalls[0].at).toBe(2000);
    expect(notionCalls[2].at - notionCalls[1].at).toBe(2000);
  });

  it("3 回とも 5xx → retryable のまま返す (呼び出し側が Queue に回す)", async () => {
    const { notionCalls } = stubFetch({ notion: () => notionError(500) });
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r).toMatchObject({ ok: false, status: 500, retryable: true, attempts: 3 });
    expect(notionCalls).toHaveLength(3);
  });

  it("400 は再試行しない", async () => {
    const { notionCalls } = stubFetch({
      notion: () =>
        Response.json(
          { object: "error", status: 400, code: "validation_error", message: "bad select" },
          { status: 400 },
        ),
    });
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r).toMatchObject({ ok: false, status: 400, retryable: false, attempts: 1 });
    expect(r.message).toBe("bad select");
    expect(notionCalls).toHaveLength(1);
  });

  it("429 + Retry-After: 5 → 5 秒待ってから再試行", async () => {
    const { notionCalls } = stubFetch({
      notion: (_c, n) => (n === 1 ? notionError(429, { "Retry-After": "5" }) : notionPage("p")),
    });
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r.ok).toBe(true);
    expect(notionCalls[1].at - notionCalls[0].at).toBe(5000);
  });

  it("Retry-After が 10 秒を超える → 待たずに打ち切り、Retry-After を返す", async () => {
    const { notionCalls } = stubFetch({
      notion: () => notionError(429, { "Retry-After": "30" }),
    });
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r).toMatchObject({ ok: false, status: 429, retryable: true, attempts: 1, retryAfterSec: 30 });
    expect(notionCalls).toHaveLength(1);
  });

  it("通信エラーも再試行する", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) throw new TypeError("network connection lost");
        return notionPage("p");
      }),
    );
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("応答が 10 秒返らなければ打ち切る (以降は締め切りに間に合わないので Queue へ)", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const r = await settle(writeNotionWithRetry("t", BODY, new InvocationBudget()));
    expect(r).toMatchObject({ ok: false, status: null, retryable: true, attempts: 1 });
    expect(Date.now() - started).toBe(10_000);
  });

  it("この invocation で Notion 停止が分かっていたら呼ばずに返す", async () => {
    const { notionCalls } = stubFetch();
    const budget = new InvocationBudget();
    budget.reportNotionFailure();
    const r = await settle(writeNotionWithRetry("t", BODY, budget));
    expect(r).toMatchObject({ ok: false, retryable: true, attempts: 0 });
    expect(notionCalls).toHaveLength(0);
  });
});
