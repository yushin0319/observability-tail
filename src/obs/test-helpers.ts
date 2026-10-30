/**
 * テスト用の外部依存の偽物 (fetch と Queue だけ)。本番コードからは import しない。
 */
import { vi } from "vitest";
import type { JsonObject, ObsRetryMessage } from "./types";

export const NOTION_URL = "https://api.notion.com/v1/pages";
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
 * 既定は Notion = ページ作成成功、Discord = 204。
 */
export function stubFetch(opts: { notion?: Responder; discord?: Responder } = {}) {
  const notionCalls: RecordedCall[] = [];
  const discordCalls: RecordedCall[] = [];
  const otherCalls: RecordedCall[] = [];
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
    if (url === NOTION_URL) {
      notionCalls.push(call);
      return notion(call, notionCalls.length);
    }
    if (url === DISCORD_URL) {
      discordCalls.push(call);
      return discord(call, discordCalls.length);
    }
    otherCalls.push(call);
    return new Response("unexpected", { status: 599 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, notionCalls, discordCalls, otherCalls };
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

/** KV namespace の偽物 (get / put / delete と TTL の記録だけ) */
export function makeKV() {
  const store = new Map<string, { value: string; ttl?: number }>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { kv: kv as unknown as KVNamespace, store, raw: kv };
}

/** Queue binding の偽物 */
export function makeQueue() {
  const sent: MessageSendRequest<ObsRetryMessage>[] = [];
  const queue = {
    sendBatch: vi.fn(async (msgs: Iterable<MessageSendRequest<ObsRetryMessage>>) => {
      sent.push(...msgs);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
    send: vi.fn(async (body: ObsRetryMessage, options?: QueueSendOptions) => {
      sent.push({ body, delaySeconds: options?.delaySeconds });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
    metrics: vi.fn(async () => ({ backlogCount: 0, backlogBytes: 0 })),
  };
  return { queue: queue as unknown as Queue<ObsRetryMessage>, sent, raw: queue };
}

/** Queue consumer に渡す MessageBatch の偽物 */
export function makeBatch(bodies: unknown[], attempts = 1) {
  const messages = bodies.map((body, i) => ({
    id: `msg-${i}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  const batch = {
    queue: "obs-notify-retry",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { batch: batch as unknown as MessageBatch<unknown>, messages };
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

/** Notion に送った本文から subject を取り出す */
export function subjectOf(notionBody: JsonObject): string {
  const props = notionBody.properties as Record<string, any>;
  return props.subject.title[0].text.content as string;
}
