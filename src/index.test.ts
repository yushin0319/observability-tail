/**
 * src/index.ts のテスト. Tail Worker は env と KV をモックして動作確認する。
 */
import { describe, expect, it, vi } from "vitest";
import worker from "./index";

interface MockKV {
  store: Map<string, string>;
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, opts?: { expirationTtl: number }) => Promise<void>;
}

function makeKV(): MockKV {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
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

describe("observability-tail Worker", () => {
  it("level=error のログ 1 件で Discord に POST する", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const kv = makeKV();
    const env = {
      DEDUP_KV: kv as unknown as KVNamespace,
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x/y",
    };
    const events = [
      makeEvent({
        logs: [{ message: ["BOOM"], level: "error", timestamp: Date.now() }],
      }),
    ];
    const ctx = makeCtx();

    await worker.tail(events as unknown as Parameters<typeof worker.tail>[0], env, ctx);
    await Promise.all(ctx.promises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/x/y");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.embeds[0].title).toContain("shirankedo");
    expect(body.embeds[0].description).toContain("BOOM");
  });

  it("info ログは Discord に流さない", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DEDUP_KV: makeKV() as unknown as KVNamespace,
      DISCORD_WEBHOOK_URL: "https://x",
    };
    const events = [
      makeEvent({
        logs: [{ message: ["hi"], level: "info", timestamp: Date.now() }],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail(events as unknown as Parameters<typeof worker.tail>[0], env, ctx);
    await Promise.all(ctx.promises);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("60秒以内の同一メッセージは KV ヒットでスキップ", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const kv = makeKV();
    const env = {
      DEDUP_KV: kv as unknown as KVNamespace,
      DISCORD_WEBHOOK_URL: "https://x",
    };
    const ctx = makeCtx();

    const events1 = [
      makeEvent({
        logs: [{ message: ["BOOM"], level: "error", timestamp: 1 }],
      }),
    ];
    await worker.tail(events1 as unknown as Parameters<typeof worker.tail>[0], env, ctx);
    await Promise.all(ctx.promises);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const ctx2 = makeCtx();
    const events2 = [
      makeEvent({
        logs: [{ message: ["BOOM"], level: "error", timestamp: 2 }],
      }),
    ];
    await worker.tail(events2 as unknown as Parameters<typeof worker.tail>[0], env, ctx2);
    await Promise.all(ctx2.promises);
    // KV にヒットして 2 回目は POST されない
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exception 1 件でも Discord に POST する", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("", { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DEDUP_KV: makeKV() as unknown as KVNamespace,
      DISCORD_WEBHOOK_URL: "https://x",
    };
    const events = [
      makeEvent({
        exceptions: [
          { name: "TypeError", message: "x is undefined", timestamp: Date.now() },
        ],
      }),
    ];
    const ctx = makeCtx();
    await worker.tail(events as unknown as Parameters<typeof worker.tail>[0], env, ctx);
    await Promise.all(ctx.promises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.embeds[0].description).toContain("TypeError");
  });
});
