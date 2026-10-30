/**
 * obs-notify 処理本体: Discord / Notion / 再送キュー / Queue consumer。
 * 外部 HTTP (fetch) と Queue だけ偽物にする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvocationBudget } from "./budget";
import { convertGrafana } from "./converters/grafana";
import { OBS_DB_ID, ObsPayloadError } from "./prepNotify";
import { consumeRetryBatch, processPayloads } from "./process";
import {
  DISCORD_URL,
  makeBatch,
  makeKV,
  makeQueue,
  notionError,
  notionPage,
  settle,
  stubFetch,
  subjectOf,
  useFakeClock,
} from "./test-helpers";
import type { ObsEnv } from "./types";

function makeEnv(overrides: Partial<ObsEnv> = {}): ObsEnv {
  return {
    NOTION_TOKEN: "notion-token",
    DISCORD_CRITICAL_URL: DISCORD_URL,
    ...overrides,
  };
}

const run = settle;

const warning = {
  severity: "warning",
  service: "cf-worker",
  subject: "⚠ shirankedo exception",
  summary: "TypeError: x is undefined",
  repo: "shirankedo",
};
const critical = { ...warning, severity: "critical", subject: "🚨 本番停止" };

function grafanaBody(count: number, severity = "warning") {
  return {
    status: "firing",
    alerts: Array.from({ length: count }, (_, i) => ({
      status: "firing",
      labels: { alertname: `Alert ${i}`, severity, host: "n8n-server" },
      annotations: { summary: `summary ${i}` },
    })),
  };
}

beforeEach(() => {
  useFakeClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("processPayloads", () => {
  it("warning: Discord には送らず Notion に書き、n8n と同じ形の応答を返す", async () => {
    const { notionCalls, discordCalls } = stubFetch();
    const [res] = await run(processPayloads(makeEnv(), [warning]));

    expect(discordCalls).toHaveLength(0);
    expect(notionCalls).toHaveLength(1);
    expect(subjectOf(notionCalls[0].json)).toBe("⚠ shirankedo exception");
    expect(res).toEqual({
      success: true,
      severity: "warning",
      service: "cf-worker",
      channel: "obs-warning",
      discord: { ok: true, status: null, skipped: true },
      notion: { ok: true, page_id: "page-1", error_code: null },
    });
  });

  it("critical: Discord (@here) → Notion の順に送り、discord_channel を記録する", async () => {
    const { fetchMock, notionCalls, discordCalls } = stubFetch();
    const [res] = await run(processPayloads(makeEnv(), [critical]));

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      DISCORD_URL,
      "https://api.notion.com/v1/pages",
    ]);
    expect(discordCalls[0].json.content).toBe("@here");
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.discord_channel.select.name).toBe("obs-critical");
    expect(res.success).toBe(true);
    expect(res.discord).toEqual({ ok: true, status: 204 });
  });

  it("Discord が 500 でも Notion には書く。discord_channel は入れない", async () => {
    const { notionCalls } = stubFetch({
      discord: () => new Response("oops", { status: 500 }),
    });
    const [res] = await run(processPayloads(makeEnv(), [critical]));

    expect(notionCalls).toHaveLength(1);
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.discord_channel).toBeUndefined();
    expect(props.severity.select.name).toBe("critical");
    expect(res.success).toBe(false);
    expect(res.discord).toEqual({ ok: false, status: 500 });
    expect(res.notion.ok).toBe(true);
  });

  it("Discord が通信エラーでも Notion には書く", async () => {
    const notionCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === DISCORD_URL) throw new TypeError("connection reset");
        notionCalls.push(url);
        return notionPage("p");
      }),
    );
    const [res] = await run(processPayloads(makeEnv(), [critical]));
    expect(notionCalls).toHaveLength(1);
    expect(res.discord).toEqual({ ok: false, status: null });
    expect(res.notion).toEqual({ ok: true, page_id: "p", error_code: null });
  });

  it("critical でも DISCORD_CRITICAL_URL 未設定なら送らず success=false (n8n と同じ)", async () => {
    const { discordCalls, notionCalls } = stubFetch();
    const [res] = await run(
      processPayloads(makeEnv({ DISCORD_CRITICAL_URL: undefined }), [critical]),
    );
    expect(discordCalls).toHaveLength(0);
    expect(notionCalls).toHaveLength(1);
    expect(res.discord).toEqual({ ok: false, status: null, skipped: true });
    expect(res.success).toBe(false);
  });

  it("Notion が 3 回とも 5xx → 再送キューに積み queued=true を返す", async () => {
    const { notionCalls } = stubFetch({ notion: () => notionError(503) });
    const { queue, sent } = makeQueue();
    const [res] = await run(
      processPayloads(makeEnv({ OBS_RETRY_QUEUE: queue }), [warning]),
    );

    expect(notionCalls).toHaveLength(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].delaySeconds).toBe(30);
    expect(subjectOf(sent[0].body.notionBody)).toBe("⚠ shirankedo exception");
    expect(sent[0].body.notionBody).toEqual(notionCalls[0].json);
    expect(res.success).toBe(false);
    expect(res.notion).toEqual({
      ok: false,
      page_id: null,
      error_code: "503",
      queued: true,
    });
  });

  it("Queue binding が無ければ書けなかったことだけ返す", async () => {
    stubFetch({ notion: () => notionError(502) });
    const [res] = await run(processPayloads(makeEnv(), [warning]));
    expect(res.notion).toEqual({ ok: false, page_id: null, error_code: "502" });
  });

  it("Notion 400 は再送しても通らないので Queue に積まない", async () => {
    const { notionCalls } = stubFetch({
      notion: () => Response.json({ object: "error", code: "validation_error" }, { status: 400 }),
    });
    const { queue, sent } = makeQueue();
    const [res] = await run(
      processPayloads(makeEnv({ OBS_RETRY_QUEUE: queue }), [warning]),
    );
    expect(notionCalls).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(res.notion).toEqual({ ok: false, page_id: null, error_code: "400" });
  });

  it("Retry-After が長い 429 は待たずに Queue へ。配信遅延に Retry-After を使う", async () => {
    stubFetch({ notion: () => notionError(429, { "Retry-After": "90" }) });
    const { queue, sent } = makeQueue();
    await run(processPayloads(makeEnv({ OBS_RETRY_QUEUE: queue }), [warning]));
    expect(sent).toHaveLength(1);
    expect(sent[0].delaySeconds).toBe(90);
  });

  it("不正な payload は副作用の前に ObsPayloadError", async () => {
    const { fetchMock } = stubFetch();
    await expect(
      processPayloads(makeEnv(), [warning, { ...warning, service: "nope" }]),
    ).rejects.toThrow(ObsPayloadError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Grafana 13 件: 10 件だけ 350ms 以上空けて書き、残り 3 件は 1 回の sendBatch で Queue へ", async () => {
    const { fetchMock, notionCalls } = stubFetch();
    const { queue, sent, raw } = makeQueue();
    const payloads = convertGrafana(grafanaBody(13));
    const results = await run(
      processPayloads(makeEnv({ OBS_RETRY_QUEUE: queue }), payloads),
    );

    expect(notionCalls).toHaveLength(10);
    for (let i = 1; i < notionCalls.length; i++) {
      expect(notionCalls[i].at - notionCalls[i - 1].at).toBeGreaterThanOrEqual(350);
    }
    expect(notionCalls.map((c) => subjectOf(c.json))).toEqual(
      payloads.slice(0, 10).map((p) => p.subject),
    );
    expect(raw.sendBatch).toHaveBeenCalledTimes(1);
    expect(sent.map((m) => m.body.subject)).toEqual(
      payloads.slice(10).map((p) => p.subject),
    );
    expect(results.filter((r) => r.notion.ok)).toHaveLength(10);
    expect(results.filter((r) => r.notion.queued)).toHaveLength(3);
    // subrequest: fetch 10 + Queue 1
    expect(fetchMock.mock.calls.length + raw.sendBatch.mock.calls.length).toBe(11);
  });

  it("Grafana 13 件で Queue が無い → 3 件は書けなかったと返す", async () => {
    stubFetch();
    const results = await run(
      processPayloads(makeEnv(), convertGrafana(grafanaBody(13))),
    );
    const failed = results.filter((r) => !r.notion.ok);
    expect(failed).toHaveLength(3);
    expect(failed.every((r) => r.notion.queued === undefined)).toBe(true);
  });

  it("Grafana critical 30 件でも 1 invocation の subrequest は 50 より十分少ない", async () => {
    const { fetchMock } = stubFetch({ notion: (_c, n) => (n % 2 ? notionError(429) : notionPage(`p${n}`)) });
    const { queue, raw } = makeQueue();
    await run(
      processPayloads(
        makeEnv({ OBS_RETRY_QUEUE: queue }),
        convertGrafana(grafanaBody(30, "critical")),
      ),
    );
    const total = fetchMock.mock.calls.length + raw.sendBatch.mock.calls.length;
    expect(total).toBeLessThanOrEqual(35);
  });

  it("Discord が応答しなくても 20 秒の締め切り内に終え、書けなかった分は Queue へ", async () => {
    const notionAt: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            if (url !== DISCORD_URL) {
              notionAt.push(Date.now());
              resolve(notionPage(`p${notionAt.length}`));
              return;
            }
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const { queue, sent } = makeQueue();
    const started = Date.now();
    const results = await run(
      processPayloads(
        makeEnv({ OBS_RETRY_QUEUE: queue }),
        convertGrafana(grafanaBody(5, "critical")),
      ),
    );
    expect(Date.now() - started).toBeLessThanOrEqual(20_000);
    expect(results).toHaveLength(5);
    expect(notionAt.length + sent.length).toBe(5);
    expect(results.every((r) => r.discord.ok === false)).toBe(true);
  });

  it("1 件目で Notion が落ちていると分かったら、残りは試さず Queue に回す", async () => {
    const { notionCalls } = stubFetch({ notion: () => notionError(500) });
    const { queue, sent } = makeQueue();
    const results = await run(
      processPayloads(makeEnv({ OBS_RETRY_QUEUE: queue }), convertGrafana(grafanaBody(4))),
    );
    expect(notionCalls).toHaveLength(3);
    expect(sent).toHaveLength(4);
    expect(results.every((r) => r.notion.queued)).toBe(true);
  });

  it("tail 経路のように並行して呼んでも Notion 呼び出しは 350ms 以上空く", async () => {
    const { notionCalls } = stubFetch();
    const env = makeEnv();
    const budget = new InvocationBudget();
    await run(
      Promise.all([
        processPayloads(env, [warning], budget),
        processPayloads(env, [{ ...warning, subject: "2" }], budget),
        processPayloads(env, [{ ...warning, subject: "3" }], budget),
      ]),
    );
    const starts = notionCalls.map((c) => c.at).sort((a, b) => a - b);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(350);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(350);
  });

  it("NOTION_TOKEN 未設定なら Notion を呼ばず失敗を返す", async () => {
    const { notionCalls } = stubFetch();
    const [res] = await run(
      processPayloads(makeEnv({ NOTION_TOKEN: undefined }), [warning]),
    );
    expect(notionCalls).toHaveLength(0);
    expect(res.notion.ok).toBe(false);
  });
});

describe("critical の Discord 重複抑制", () => {
  it("60 秒以内の同じ critical は Discord を鳴らさず Notion にだけ記録する", async () => {
    const { discordCalls, notionCalls } = stubFetch();
    const { kv, store } = makeKV();
    const env = makeEnv({ DEDUP_KV: kv });

    const [first] = await run(processPayloads(env, [critical]));
    const [second] = await run(processPayloads(env, [critical]));

    expect(discordCalls).toHaveLength(1);
    expect(notionCalls).toHaveLength(2);
    const [entry] = Array.from(store.values());
    expect(store.size).toBe(1);
    expect(entry.ttl).toBe(60);

    expect(first.discord).toEqual({ ok: true, status: 204 });
    expect(second.discord).toEqual({
      ok: true,
      status: null,
      skipped: true,
      deduplicated: true,
    });
    expect(second.success).toBe(true);
    // 2 回目は Discord に送っていないので送信先は記録しない
    const props = notionCalls[1].json.properties as Record<string, any>;
    expect(props.discord_channel).toBeUndefined();
  });

  it("subject が違えば別のアラートとして送る", async () => {
    const { discordCalls } = stubFetch();
    const env = makeEnv({ DEDUP_KV: makeKV().kv });
    await run(processPayloads(env, [critical]));
    await run(processPayloads(env, [{ ...critical, subject: "🚨 別件" }]));
    expect(discordCalls).toHaveLength(2);
  });

  it("Discord に送れなかったら印を消し、次の同じアラートで送り直す", async () => {
    const { discordCalls } = stubFetch({
      discord: (_c, n) => new Response(null, { status: n === 1 ? 500 : 204 }),
    });
    const { kv, store } = makeKV();
    const env = makeEnv({ DEDUP_KV: kv });
    await run(processPayloads(env, [critical]));
    expect(store.size).toBe(0);
    const [second] = await run(processPayloads(env, [critical]));
    expect(discordCalls).toHaveLength(2);
    expect(second.discord).toEqual({ ok: true, status: 204 });
  });

  it("KV が失敗しても critical は Discord に送る", async () => {
    const { discordCalls, notionCalls } = stubFetch();
    const failing = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
      put: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace;
    const [res] = await run(processPayloads(makeEnv({ DEDUP_KV: failing }), [critical]));
    expect(discordCalls).toHaveLength(1);
    expect(notionCalls).toHaveLength(1);
    expect(res.success).toBe(true);
  });

  it("Discord への payload は allowed_mentions で everyone (@here) だけ許す", async () => {
    const { discordCalls } = stubFetch();
    await run(processPayloads(makeEnv(), [critical]));
    expect(discordCalls[0].json.allowed_mentions).toEqual({ parse: ["everyone"] });
    expect(discordCalls[0].json.content).toBe("@here");
  });
});

describe("consumeRetryBatch (Queue consumer)", () => {
  const message = (subject: string) => ({
    notionBody: {
      parent: { database_id: OBS_DB_ID },
      properties: { subject: { title: [{ text: { content: subject } }] } },
    },
    subject,
  });

  it("観測性 DB 以外を指すメッセージは Notion を呼ばず ack", async () => {
    const { notionCalls } = stubFetch();
    const other = message("x");
    const { batch, messages } = makeBatch([
      { ...other, notionBody: { ...other.notionBody, parent: { database_id: "other-db" } } },
      { ...other, notionBody: { ...other.notionBody, parent: { page_id: OBS_DB_ID } } },
    ]);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(notionCalls).toHaveLength(0);
    expect(messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
  });

  it("書けたら ack。Notion 呼び出しは 350ms 以上空ける", async () => {
    const { notionCalls } = stubFetch();
    const { batch, messages } = makeBatch([message("a"), message("b")]);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
    expect(messages.every((m) => m.retry.mock.calls.length === 0)).toBe(true);
    expect(notionCalls.map((c) => subjectOf(c.json))).toEqual(["a", "b"]);
    expect(notionCalls[1].at - notionCalls[0].at).toBeGreaterThanOrEqual(350);
  });

  it("5xx は 30 秒後に retry (1 メッセージにつき Notion は 1 回だけ)", async () => {
    const { notionCalls } = stubFetch({ notion: () => notionError(503) });
    const { batch, messages } = makeBatch([message("a")]);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(notionCalls).toHaveLength(1);
    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("429 + Retry-After: 120 は 120 秒後に retry", async () => {
    stubFetch({ notion: () => notionError(429, { "Retry-After": "120" }) });
    const { batch, messages } = makeBatch([message("a")]);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("max_retries (5) を使い切った配信でも失敗 → ack して諦める", async () => {
    stubFetch({ notion: () => notionError(500) });
    const { batch, messages } = makeBatch([message("a")], 6);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(messages[0].ack).toHaveBeenCalledTimes(1);
    expect(messages[0].retry).not.toHaveBeenCalled();
  });

  it("400 は再送しても通らないので ack", async () => {
    stubFetch({
      notion: () => Response.json({ object: "error", code: "validation_error" }, { status: 400 }),
    });
    const { batch, messages } = makeBatch([message("a")]);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(messages[0].ack).toHaveBeenCalledTimes(1);
    expect(messages[0].retry).not.toHaveBeenCalled();
  });

  it("形の壊れたメッセージは Notion を呼ばず ack", async () => {
    const { notionCalls } = stubFetch();
    const { batch, messages } = makeBatch([null, { subject: "x" }]);
    await run(consumeRetryBatch(batch, makeEnv()));
    expect(notionCalls).toHaveLength(0);
    expect(messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
  });

  it("NOTION_TOKEN 未設定なら retry (設定後に書ける)", async () => {
    const { notionCalls } = stubFetch();
    const { batch, messages } = makeBatch([message("a")]);
    await run(consumeRetryBatch(batch, makeEnv({ NOTION_TOKEN: undefined })));
    expect(notionCalls).toHaveLength(0);
    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });
});
