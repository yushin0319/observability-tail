/**
 * src/index.ts のテスト. Tail Worker は env と KV をモックして動作確認する。
 * 外部 HTTP (fetch)・KV・Queue だけ偽物にする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { NOTION_PAGES_URL } from "./obs/notion";
import {
  makeCtx,
  makeKV,
  makeQueue,
  notionError,
  settle,
  stubFetch,
  subjectOf,
  useFakeClock,
} from "./obs/test-helpers";

interface TailEventLike {
  scriptName: string | null;
  outcome: string;
  logs: { message: unknown[]; level: string; timestamp: number }[];
  exceptions: { name: string; message: string; timestamp: number }[];
  eventTimestamp: number;
}

type TailEvents = Parameters<typeof worker.tail>[0];

function makeEvent(overrides: Partial<TailEventLike> = {}): TailEventLike {
  return {
    scriptName: "shirankedo",
    outcome: "exception",
    logs: [],
    exceptions: [],
    eventTimestamp: Date.now(),
    ...overrides,
  };
}

function errorLog(message: string): TailEventLike["logs"][number] {
  return { message: [message], level: "error", timestamp: Date.now() };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const dedup = makeKV();
  const errorLogKV = makeKV();
  return {
    env: {
      DEDUP_KV: dedup.kv,
      ERROR_LOG_KV: errorLogKV.kv,
      NOTION_TOKEN: "notion-token",
      READ_TOKEN: "test-token-123",
      ...overrides,
    },
    errorLogStore: errorLogKV.store,
  };
}

type TestEnv = ReturnType<typeof makeEnv>["env"];

/** tail を呼び、waitUntil に渡された処理が終わるまで待つ */
async function runTail(env: TestEnv, events: TailEventLike[]) {
  const ctx = makeCtx();
  await worker.tail(events as unknown as TailEvents, env, ctx);
  await settle(Promise.allSettled(ctx.promises));
  return ctx;
}

beforeEach(() => {
  useFakeClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("observability-tail Worker tail handler", () => {
  it("level=error のログ 1 件で 観測性 DB (Notion) に記録 + KV 永続化する", async () => {
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv();
    await runTail(env, [makeEvent({ logs: [errorLog("BOOM")] })]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ERROR_LOG_KV にも 1 件保存されているか
    expect(errorLogStore.size).toBe(1);
    const [[key, entry]] = Array.from(errorLogStore);
    expect(key).toMatch(/^error:\d{13}:[a-f0-9]{16}$/);
    const stored = JSON.parse(entry.value);
    expect(stored.message).toBe("BOOM");
    expect(stored.scriptName).toBe("shirankedo");
    expect(stored.kind).toBe("log");
    expect(entry.ttl).toBe(7 * 24 * 3600);
  });

  it("info ログは 観測性 DB への記録も KV 永続化もしない", async () => {
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv();
    const ctx = await runTail(env, [
      makeEvent({ logs: [{ message: ["hi"], level: "info", timestamp: Date.now() }] }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLogStore.size).toBe(0);
    expect(ctx.promises).toHaveLength(0);
  });

  it("60秒以内の同一メッセージは 観測性 DB への記録は skip だが KV には毎回保存", async () => {
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv();
    // KV のキーは eventTimestamp で決まるので、2 件を別の時刻にする
    await runTail(env, [makeEvent({ eventTimestamp: 1_000, logs: [errorLog("BOOM")] })]);
    await runTail(env, [makeEvent({ eventTimestamp: 2_000, logs: [errorLog("BOOM")] })]);

    // Notion への記録は 1 回（dedup）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // KV は 2 件（dedup なし、すべての error を履歴として残す）
    expect(errorLogStore.size).toBe(2);
  });

  it("level=log でも message に type:cron_failed が含まれていれば拾う", async () => {
    // shirankedo の logCronError が console.log(JSON.stringify({type:"cron_failed",...}))
    // で吐く JSON を取りこぼさない（観測性プロジェクト 2026-05-04 の事故の本筋）
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv();
    const cronFailedJson = JSON.stringify({
      type: "cron_failed",
      cron: "daily-releases",
      error: "self-fetch returned 404",
    });
    await runTail(env, [
      makeEvent({
        logs: [{ message: [cronFailedJson], level: "log", timestamp: Date.now() }],
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorLogStore.size).toBe(1);
    const [, entry] = Array.from(errorLogStore)[0];
    const stored = JSON.parse(entry.value);
    expect(stored.message).toContain("cron_failed");
    expect(stored.message).toContain("daily-releases");
    expect(stored.kind).toBe("log");
  });

  it("level=log で cron_failed を含まない通常ログは拾わない", async () => {
    // 偽陽性チェック: 普通の構造化ログ (type:cron_started 等) で発火しないこと
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv();
    const ordinaryJson = JSON.stringify({ type: "cron_started", cron: "daily-releases" });
    await runTail(env, [
      makeEvent({
        logs: [
          { message: [ordinaryJson], level: "log", timestamp: Date.now() },
          { message: ["plain log"], level: "log", timestamp: Date.now() },
        ],
      }),
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLogStore.size).toBe(0);
  });

  it("exception 1 件でも 観測性 DB に記録 + KV 永続化", async () => {
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv();
    await runTail(env, [
      makeEvent({
        exceptions: [{ name: "TypeError", message: "x is undefined", timestamp: Date.now() }],
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, entry] = Array.from(errorLogStore)[0];
    const stored = JSON.parse(entry.value);
    expect(stored.kind).toBe("exception");
    expect(stored.message).toContain("TypeError");
  });

  it("通知は HTTP の obs-notify を経由せず、受付と同じ処理で Notion API に直接書く", async () => {
    const { notionCalls } = stubFetch();
    const { env } = makeEnv();
    await runTail(env, [
      makeEvent({
        exceptions: [{ name: "TypeError", message: "x is undefined", timestamp: Date.now() }],
      }),
    ]);

    expect(notionCalls).toHaveLength(1);
    expect(notionCalls[0].url).toBe(NOTION_PAGES_URL);
    const headers = notionCalls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer notion-token");
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.subject.title[0].text.content).toBe("⚠ shirankedo exception");
    expect(props.severity.select.name).toBe("warning");
    expect(props.service.select.name).toBe("cf-worker");
    expect(props.repo.select.name).toBe("shirankedo");
    expect(props.summary.rich_text[0].text.content).toBe("TypeError: x is undefined");
    expect(JSON.parse(props.raw_payload.rich_text[0].text.content)).toEqual({
      scriptName: "shirankedo",
      outcome: "exception",
      kind: "exception",
      message: "TypeError: x is undefined",
    });
  });

  it("NOTION_TOKEN 未設定なら記録はしないが KV 保存は続ける", async () => {
    const { fetchMock } = stubFetch();
    const { env, errorLogStore } = makeEnv({ NOTION_TOKEN: undefined });
    await runTail(env, [makeEvent({ logs: [errorLog("BOOM")] })]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLogStore.size).toBe(1);
  });

  it("Notion が落ちていたら再試行のあと再送キューに積む", async () => {
    const { fetchMock } = stubFetch({ notion: () => notionError(502) });
    const { queue, sent } = makeQueue();
    const { env } = makeEnv({ OBS_RETRY_QUEUE: queue });
    await runTail(env, [makeEvent({ logs: [errorLog("BOOM")] })]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sent).toHaveLength(1);
  });

  it("1 回の呼び出しで 12 種類のエラー → waitUntil は 1 つ、10 件書いて残り 2 件は 1 回の sendBatch", async () => {
    const { notionCalls } = stubFetch();
    const { queue, sent, sendBatch } = makeQueue();
    const { env, errorLogStore } = makeEnv({ OBS_RETRY_QUEUE: queue });
    const ctx = await runTail(env, [
      makeEvent({ logs: Array.from({ length: 12 }, (_, i) => errorLog(`BOOM ${i}`)) }),
    ]);

    expect(ctx.promises).toHaveLength(1);
    expect(errorLogStore.size).toBe(12);
    expect(notionCalls).toHaveLength(10);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sent.map((m) => subjectOf(m.body))).toEqual([
      "⚠ shirankedo log",
      "⚠ shirankedo log",
    ]);
  });

  it("同じ呼び出しの中で同じメッセージが重なっても通知は 1 回", async () => {
    const { notionCalls } = stubFetch();
    const { env } = makeEnv();
    await runTail(env, [
      makeEvent({ logs: [errorLog("BOOM"), errorLog("BOOM")] }),
      makeEvent({ scriptName: "worldpulse-api", logs: [errorLog("BOOM")] }),
    ]);
    // shirankedo の BOOM 1 回 + worldpulse-api の BOOM 1 回
    expect(notionCalls.map((c) => subjectOf(c.json))).toEqual([
      "⚠ shirankedo log",
      "⚠ worldpulse-api log",
    ]);
  });

  it("重複抑制の KV が失敗したエラーは通知せず失敗を返すが、他のエラーの通知は止めない", async () => {
    const { notionCalls } = stubFetch();
    const { kv } = makeKV();
    const flaky = {
      ...kv,
      get: async (key: string) => {
        if (key.startsWith("worldpulse-api:")) throw new Error("KV unavailable");
        return kv.get(key);
      },
    } as unknown as KVNamespace;
    const { env } = makeEnv({ DEDUP_KV: flaky });
    const ctx = await runTail(env, [
      makeEvent({ logs: [errorLog("BOOM")] }),
      makeEvent({ scriptName: "worldpulse-api", logs: [errorLog("BOOM")] }),
    ]);

    expect(notionCalls.map((c) => subjectOf(c.json))).toEqual(["⚠ shirankedo log"]);
    await expect(ctx.promises[0]).rejects.toThrow("tail dedup KV failed");
  });
});

describe("GET /errors fetch handler", () => {
  function reqWithToken(path: string, token = "test-token-123"): Request {
    return new Request(`https://obs.example/${path.replace(/^\//, "")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function seedErrorKV(env: TestEnv) {
    // Now-2h, Now-30m, Now-10s, Now-2s の 4 件投入
    const now = Date.now();
    const entries = [
      { ts: now - 7200_000, message: "old-2h", scriptName: "shirankedo" },
      { ts: now - 1800_000, message: "old-30m", scriptName: "shirankedo" },
      { ts: now - 10_000, message: "recent-10s", scriptName: "worldpulse-api" },
      { ts: now - 2_000, message: "recent-2s", scriptName: "shirankedo" },
    ];
    for (const e of entries) {
      const key = `error:${String(e.ts).padStart(13, "0")}:${Math.random().toString(36).slice(2, 10)}`;
      await env.ERROR_LOG_KV.put(
        key,
        JSON.stringify({
          ts: e.ts,
          scriptName: e.scriptName,
          outcome: "exception",
          kind: "log",
          message: e.message,
        }),
      );
    }
  }

  it("auth なしは 401", async () => {
    const { env } = makeEnv();
    const r = await worker.fetch(new Request("https://obs.example/errors"), env, makeCtx());
    expect(r.status).toBe(401);
  });

  it("間違った token は 401", async () => {
    const { env } = makeEnv();
    const r = await worker.fetch(reqWithToken("/errors", "wrong"), env, makeCtx());
    expect(r.status).toBe(401);
  });

  it("READ_TOKEN 未設定なら 503", async () => {
    const { env } = makeEnv({ READ_TOKEN: undefined });
    const r = await worker.fetch(reqWithToken("/errors"), env, makeCtx());
    expect(r.status).toBe(503);
  });

  it("since=1h で 1 時間以内の error が新しい順に返る", async () => {
    const { env } = makeEnv();
    await seedErrorKV(env);
    const r = await worker.fetch(reqWithToken("/errors?since=1h"), env, makeCtx());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      count: number;
      items: { message: string }[];
    };
    // 1h 以内: recent-2s / recent-10s / old-30m の 3 件、old-2h は除外
    expect(body.count).toBe(3);
    expect(body.items[0].message).toBe("recent-2s");
    expect(body.items[1].message).toBe("recent-10s");
    expect(body.items[2].message).toBe("old-30m");
  });

  it("script フィルタが効く", async () => {
    const { env } = makeEnv();
    await seedErrorKV(env);
    const r = await worker.fetch(
      reqWithToken("/errors?since=1h&script=worldpulse-api"),
      env,
      makeCtx(),
    );
    const body = (await r.json()) as {
      count: number;
      items: { message: string; scriptName: string }[];
    };
    expect(body.count).toBe(1);
    expect(body.items[0].scriptName).toBe("worldpulse-api");
  });

  it("/health は auth 不要で 200", async () => {
    const { env } = makeEnv();
    const r = await worker.fetch(new Request("https://obs.example/health"), env, makeCtx());
    expect(r.status).toBe(200);
  });
});
