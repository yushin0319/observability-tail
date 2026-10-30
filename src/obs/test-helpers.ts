/**
 * テスト用の外部依存の偽物 (fetch・KV・Queue・ExecutionContext) と時計の操作。
 * 本番コードからは import しない。
 */
import { vi } from "vitest";
import { NOTION_PAGES_URL } from "./notion";
import type { JsonObject, ObsRetryMessage } from "./types";

export const DISCORD_URL = "https://discord.example/api/webhooks/1/critical";

export interface RecordedCall {
  url: string;
  init: RequestInit;
  /** 呼ばれた時刻 (fake timers 下では仮想時刻) */
  at: number;
  json: JsonObject;
}

type Responder = (call: RecordedCall, nth: number) => Response | Promise<Response>;

/**
 * fetch の偽物。Notion / Discord それぞれ n 回目の呼び出しに返す応答を関数で決める。
 * 既定は Notion = ページ作成成功、Discord = 204。それ以外の URL は 599。
 */
export function stubFetch(opts: { notion?: Responder; discord?: Responder } = {}) {
  const notionCalls: RecordedCall[] = [];
  const discordCalls: RecordedCall[] = [];
  const notion: Responder = opts.notion ?? ((_c, n) => notionPage(`page-${n}`));
  const discord: Responder = opts.discord ?? (() => new Response(null, { status: 204 }));

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const call: RecordedCall = {
      url,
      init: init ?? {},
      at: Date.now(),
      json: body ? (JSON.parse(body) as JsonObject) : {},
    };
    if (url === NOTION_PAGES_URL) {
      notionCalls.push(call);
      return notion(call, notionCalls.length);
    }
    if (url === DISCORD_URL) {
      discordCalls.push(call);
      return discord(call, discordCalls.length);
    }
    return new Response("unexpected", { status: 599 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, notionCalls, discordCalls };
}

export function notionPage(id: string): Response {
  return Response.json({ object: "page", id });
}

export function notionError(status: number, headers: Record<string, string> = {}): Response {
  return Response.json(
    { object: "error", status, code: status === 429 ? "rate_limited" : "internal_server_error", message: `HTTP ${status}` },
    { status, headers },
  );
}

/** KV namespace の偽物 (get / put / delete / list と TTL の記録) */
export function makeKV() {
  const store = new Map<string, { value: string; ttl?: number }>();
  const kv = {
    get: async (key: string) => store.get(key)?.value ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(opts?.prefix ?? ""))
        .map((name) => ({ name })),
      list_complete: true,
    }),
  };
  return { kv: kv as unknown as KVNamespace, store };
}

/** Queue binding の偽物 (sendBatch だけ) */
export function makeQueue() {
  const sent: MessageSendRequest<ObsRetryMessage>[] = [];
  const sendBatch = vi.fn(async (msgs: Iterable<MessageSendRequest<ObsRetryMessage>>) => {
    sent.push(...msgs);
  });
  return { queue: { sendBatch } as unknown as Queue<ObsRetryMessage>, sent, sendBatch };
}

/** Queue consumer に渡す MessageBatch の偽物 */
export function makeBatch(bodies: unknown[], attempts = 1) {
  const messages = bodies.map((body, i) => ({
    id: `msg-${i}`,
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return { batch: { messages } as unknown as MessageBatch<unknown>, messages };
}

/** ExecutionContext の偽物。waitUntil に渡された Promise を集める */
export function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext & { promises: Promise<unknown>[] };
}

/** テストは Node で動くので setImmediate がある (Workers の型定義には無い) */
const realSetImmediate = (
  globalThis as unknown as { setImmediate: (cb: () => void) => void }
).setImmediate;

/**
 * setTimeout と Date だけ偽物にする (setImmediate は本物のまま残し、settle で実時間を進めるのに使う)。
 */
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/**
 * fake timers 下で p が終わるまで時計を進める。
 * crypto.subtle などタイマー以外の非同期を待っている間は、本物の setImmediate で 1 周ずつ譲る。
 */
export async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 100_000 && !done; i++) {
    if (vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
    } else {
      await new Promise<void>((resolve) => realSetImmediate(resolve));
    }
  }
  return p;
}

/** Notion に送った本文 (または再送メッセージ) から subject を取り出す */
export function subjectOf(withProperties: { properties?: unknown }): string {
  const props = withProperties.properties as Record<string, any>;
  return props.subject.title[0].text.content as string;
}
