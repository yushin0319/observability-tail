/**
 * src/index.ts のテスト. Tail Worker は env と KV をモックして動作確認する。
 */
import { describe, expect, it, vi } from "vitest";
import worker from "./index";

interface MockKV {
  store: Map<string, { value: string; ttl?: number }>;
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    opts?: { expirationTtl: number },
  ) => Promise<void>;
  list: (opts?: {
    prefix?: string;
    limit?: number;
  }) => Promise<{ keys: { name: string }[]; list_complete: boolean }>;
}

function makeKV(): MockKV {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    get: async (key) => store.get(key)?.value ?? null,
    put: async (key, value, opts) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    list: async (opts) => {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

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

interface TailEventLike {
  scriptName: string | null;
  outcome: string;
  logs: { message: unknown[]; level: string; timestamp: number }[];
  exceptions: { name: string; message: string; timestamp: number }[];
  eventTimestamp: number;
}

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext & { promises: Promise<unknown>[] };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DEDUP_KV: makeKV() as unknown as KVNamespace,
    ERROR_LOG_KV: makeKV() as unknown as KVNamespace,
    OBS_NOTIFY_URL: "https://yushin-n8n.duckdns.org/webhook/obs-notify",
    READ_TOKEN: "test-token-123",
    ...overrides,
  };
}

describe("observability-tail Worker tail handler", () => {
  it("level=error のログ 1 件で obs-notify に POST + KV 永続化する", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const env = makeEnv();
    const events = [
      makeEvent({
        logs: [{ message: ["BOOM"], level: "error", timestamp: Date.now() }],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail!(
      events as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx,
    );
    await Promise.all(ctx.promises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ERROR_LOG_KV にも 1 件保存されているか
    const erroLogStore = (env.ERROR_LOG_KV as unknown as MockKV).store;
    expect(erroLogStore.size).toBe(1);
    const [[key, entry]] = Array.from(erroLogStore);
    expect(key).toMatch(/^error:\d{13}:[a-f0-9]+$/);
    const stored = JSON.parse(entry.value);
    expect(stored.message).toBe("BOOM");
    expect(stored.scriptName).toBe("shirankedo");
    expect(stored.kind).toBe("log");
    expect(entry.ttl).toBe(7 * 24 * 3600);
  });

  it("info ログは obs-notify も KV 永続化もしない", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv();
    const events = [
      makeEvent({
        logs: [{ message: ["hi"], level: "info", timestamp: Date.now() }],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail!(
      events as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx,
    );
    await Promise.all(ctx.promises);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (env.ERROR_LOG_KV as unknown as MockKV).store.size,
    ).toBe(0);
  });

  it("60秒以内の同一メッセージは obs-notify skip だが KV には毎回保存", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv();

    const ctx1 = makeCtx();
    await worker.tail!(
      [makeEvent({ logs: [{ message: ["BOOM"], level: "error", timestamp: 1 }] })] as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx1,
    );
    await Promise.all(ctx1.promises);

    const ctx2 = makeCtx();
    await worker.tail!(
      [makeEvent({ logs: [{ message: ["BOOM"], level: "error", timestamp: 2 }] })] as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx2,
    );
    await Promise.all(ctx2.promises);

    // obs-notify は 1 回（dedup）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // KV は 2 件（dedup なし、すべての error を履歴として残す）
    expect(
      (env.ERROR_LOG_KV as unknown as MockKV).store.size,
    ).toBe(2);
  });

  it("level=log でも message に type:cron_failed が含まれていれば拾う", async () => {
    // shirankedo の logCronError が console.log(JSON.stringify({type:"cron_failed",...}))
    // で吐く JSON を取りこぼさない（観測性プロジェクト 2026-05-04 の事故の本筋）
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv();
    const cronFailedJson = JSON.stringify({
      type: "cron_failed",
      cron: "daily-releases",
      error: "self-fetch returned 404",
    });
    const events = [
      makeEvent({
        logs: [
          { message: [cronFailedJson], level: "log", timestamp: Date.now() },
        ],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail!(
      events as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx,
    );
    await Promise.all(ctx.promises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const erroLogStore = (env.ERROR_LOG_KV as unknown as MockKV).store;
    expect(erroLogStore.size).toBe(1);
    const [, entry] = Array.from(erroLogStore)[0];
    const stored = JSON.parse(entry.value);
    expect(stored.message).toContain("cron_failed");
    expect(stored.message).toContain("daily-releases");
    expect(stored.kind).toBe("log");
  });

  it("level=log で cron_failed を含まない通常ログは拾わない", async () => {
    // 偽陽性チェック: 普通の構造化ログ (type:cron_started 等) で発火しないこと
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv();
    const ordinaryJson = JSON.stringify({
      type: "cron_started",
      cron: "daily-releases",
    });
    const events = [
      makeEvent({
        logs: [
          { message: [ordinaryJson], level: "log", timestamp: Date.now() },
          { message: ["plain log"], level: "log", timestamp: Date.now() },
        ],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail!(
      events as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx,
    );
    await Promise.all(ctx.promises);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (env.ERROR_LOG_KV as unknown as MockKV).store.size,
    ).toBe(0);
  });

  it("exception 1 件でも obs-notify に POST + KV 永続化", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv();
    const events = [
      makeEvent({
        exceptions: [
          { name: "TypeError", message: "x is undefined", timestamp: Date.now() },
        ],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail!(
      events as unknown as Parameters<NonNullable<typeof worker.tail>>[0],
      env,
      ctx,
    );
    await Promise.all(ctx.promises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, entry] = Array.from(
      (env.ERROR_LOG_KV as unknown as MockKV).store,
    )[0];
    const stored = JSON.parse(entry.value);
    expect(stored.kind).toBe("exception");
    expect(stored.message).toContain("TypeError");
  });
});

describe("GET /errors fetch handler", () => {
  function reqWithToken(path: string, token = "test-token-123"): Request {
    return new Request(`https://obs.example/${path.replace(/^\//, "")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function seedErrorKV(env: ReturnType<typeof makeEnv>) {
    // Now-2h, Now-30m, Now-10s, Now-2s の 4 件投入
    const kv = env.ERROR_LOG_KV as unknown as MockKV;
    const now = Date.now();
    const entries = [
      { ts: now - 7200_000, message: "old-2h", scriptName: "shirankedo" },
      { ts: now - 1800_000, message: "old-30m", scriptName: "shirankedo" },
      { ts: now - 10_000, message: "recent-10s", scriptName: "worldpulse-api" },
      { ts: now - 2_000, message: "recent-2s", scriptName: "shirankedo" },
    ];
    for (const e of entries) {
      const key = `error:${String(e.ts).padStart(13, "0")}:${Math.random().toString(36).slice(2, 10)}`;
      await kv.put(
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
    const env = makeEnv();
    const r = await worker.fetch!(
      new Request("https://obs.example/errors"),
      env,
    );
    expect(r.status).toBe(401);
  });

  it("間違った token は 401", async () => {
    const env = makeEnv();
    const r = await worker.fetch!(reqWithToken("/errors", "wrong"), env);
    expect(r.status).toBe(401);
  });

  it("READ_TOKEN 未設定なら 503", async () => {
    const env = makeEnv({ READ_TOKEN: undefined });
    const r = await worker.fetch!(reqWithToken("/errors"), env);
    expect(r.status).toBe(503);
  });

  it("since=1h で 1 時間以内の error が新しい順に返る", async () => {
    const env = makeEnv();
    await seedErrorKV(env);
    const r = await worker.fetch!(
      reqWithToken("/errors?since=1h"),
      env,
    );
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
    const env = makeEnv();
    await seedErrorKV(env);
    const r = await worker.fetch!(
      reqWithToken("/errors?since=1h&script=worldpulse-api"),
      env,
    );
    const body = (await r.json()) as {
      count: number;
      items: { message: string; scriptName: string }[];
    };
    expect(body.count).toBe(1);
    expect(body.items[0].scriptName).toBe("worldpulse-api");
  });

  it("/health は auth 不要で 200", async () => {
    const env = makeEnv();
    const r = await worker.fetch!(
      new Request("https://obs.example/health"),
      env,
    );
    expect(r.status).toBe(200);
  });
});
