/**
 * 受付エンドポイントのルーティングと認証 (worker.fetch 経由)。
 * 外部 HTTP (fetch) と Queue だけ偽物にする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import {
  DISCORD_URL,
  makeQueue,
  notionError,
  settle,
  stubFetch,
  subjectOf,
  useFakeClock,
} from "./test-helpers";

const WEBHOOK_SECRET = "webhook-secret-for-test";
const ADAPTER_TOKEN = "adapter-token-for-test";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DEDUP_KV: {} as KVNamespace,
    ERROR_LOG_KV: {} as KVNamespace,
    READ_TOKEN: "read-token",
    WEBHOOK_SECRET,
    ADAPTER_TOKEN,
    NOTION_TOKEN: "notion-token",
    DISCORD_CRITICAL_URL: DISCORD_URL,
    ...overrides,
  };
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

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://obs.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(req: Request, env = makeEnv(), ctx = makeCtx()) {
  return settle(worker.fetch(req, env, ctx));
}

const validNotify = {
  severity: "warning",
  service: "cf-worker",
  subject: "⚠ worldpulse-api cron_failed",
  repo: "WorldPulse",
};

const sentryIssue = {
  action: "triggered",
  data: {
    issue: {
      id: "12345",
      title: "Connection refused",
      level: "error",
      permalink: "https://sentry.io/organizations/x/issues/12345/",
      project: { slug: "shirankedo" },
    },
  },
};

beforeEach(() => {
  useFakeClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("POST /obs-notify", () => {
  it("X-Webhook-Secret なし → 403 (本文なし) / 外部呼び出しなし", async () => {
    const { fetchMock } = stubFetch();
    const r = await call(post("/obs-notify", validNotify));
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("X-Webhook-Secret 不一致 → 403", async () => {
    const { fetchMock } = stubFetch();
    const r = await call(post("/obs-notify", validNotify, { "X-Webhook-Secret": "wrong" }));
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ADAPTER_TOKEN では通らない (secret は別)", async () => {
    stubFetch();
    const r = await call(post("/obs-notify", validNotify, { "X-Webhook-Secret": ADAPTER_TOKEN }));
    expect(r.status).toBe(403);
  });

  it("WEBHOOK_SECRET 未設定なら誰も通さない", async () => {
    stubFetch();
    const r = await call(
      post("/obs-notify", validNotify, { "X-Webhook-Secret": "" }),
      makeEnv({ WEBHOOK_SECRET: undefined }),
    );
    expect(r.status).toBe(403);
  });

  it("正しい secret → 200 / n8n の api/obs-notify と同じ応答 / 処理を waitUntil にも渡す", async () => {
    const { notionCalls } = stubFetch();
    const ctx = makeCtx();
    const r = await call(
      post("/obs-notify", validNotify, { "X-Webhook-Secret": WEBHOOK_SECRET }),
      makeEnv(),
      ctx,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      success: true,
      severity: "warning",
      service: "cf-worker",
      channel: "obs-warning",
      discord: { ok: true, status: null, skipped: true },
      notion: { ok: true, page_id: "page-1", error_code: null },
    });
    expect(notionCalls).toHaveLength(1);
    expect(subjectOf(notionCalls[0].json)).toBe("⚠ worldpulse-api cron_failed");
    expect(ctx.promises).toHaveLength(1);
  });

  it("Notion 失敗 → 200 で success=false (n8n と同じく HTTP は 200)、Queue に積む", async () => {
    stubFetch({ notion: () => notionError(500) });
    const { queue, sent } = makeQueue();
    const r = await call(
      post("/obs-notify", validNotify, { "X-Webhook-Secret": WEBHOOK_SECRET }),
      makeEnv({ OBS_RETRY_QUEUE: queue }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { success: boolean; notion: unknown };
    expect(body.success).toBe(false);
    expect(body.notion).toEqual({ ok: false, page_id: null, error_code: "500", queued: true });
    expect(sent).toHaveLength(1);
  });

  it("不正 payload → 400 と、受け付けなかったことを warning で記録", async () => {
    const { notionCalls } = stubFetch();
    const r = await call(
      post("/obs-notify", { ...validNotify, severity: "fatal" }, { "X-Webhook-Secret": WEBHOOK_SECRET }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("severity must be one of");

    expect(notionCalls).toHaveLength(1);
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.subject.title[0].text.content).toBe("❌ obs-intake エラー (/obs-notify)");
    expect(props.service.select.name).toBe("observability-tail");
    expect(props.severity.select.name).toBe("warning");
    expect(props.summary.rich_text[0].text.content).toContain("[PrepNotify] severity must be one of");
    expect(props.raw_payload.rich_text[0].text.content).toContain('"severity":"fatal"');
  });

  it("JSON でない本文 → 400 + 記録", async () => {
    const { notionCalls } = stubFetch();
    const r = await call(post("/obs-notify", "{not json", { "X-Webhook-Secret": WEBHOOK_SECRET }));
    expect(r.status).toBe(400);
    expect(notionCalls).toHaveLength(1);
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.summary.rich_text[0].text.content).toContain("[ParseBody]");
  });

  it("GET → 405", async () => {
    stubFetch();
    const r = await call(new Request("https://obs.example/obs-notify"));
    expect(r.status).toBe(405);
  });

  it("NOTION_TOKEN 未設定 → 認証後に 503", async () => {
    stubFetch();
    const r = await call(
      post("/obs-notify", validNotify, { "X-Webhook-Secret": WEBHOOK_SECRET }),
      makeEnv({ NOTION_TOKEN: undefined }),
    );
    expect(r.status).toBe(503);
  });
});

describe("POST /obs-from/{name}", () => {
  it("X-Adapter-Token ヘッダで通る → n8n の adapter と同じ success/forwarded", async () => {
    const { notionCalls } = stubFetch();
    const r = await call(
      post("/obs-from/sentry", sentryIssue, { "X-Adapter-Token": ADAPTER_TOKEN }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      success: true,
      forwarded: true,
      items: 1,
      written: 1,
      queued: 0,
      failed: 0,
    });
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.service.select.name).toBe("sentry");
    expect(props.repo.select.name).toBe("shirankedo");
    expect(props.subject.title[0].text.content).toBe("🐛 Connection refused");
  });

  it("パス末尾のトークンで通る (ヘッダを付けられない Sentry 用)", async () => {
    const { notionCalls } = stubFetch();
    const r = await call(post(`/obs-from/sentry/${ADAPTER_TOKEN}`, sentryIssue));
    expect(r.status).toBe(200);
    expect(notionCalls).toHaveLength(1);
  });

  it("トークンなし / 不一致 (ヘッダ・パス) → 403", async () => {
    const { fetchMock } = stubFetch();
    for (const req of [
      post("/obs-from/healthchecks", { name: "x", status: "down" }),
      post("/obs-from/healthchecks", { name: "x" }, { "X-Adapter-Token": "wrong" }),
      post("/obs-from/healthchecks/wrong", { name: "x" }),
      post("/obs-from/healthchecks", { name: "x" }, { "X-Adapter-Token": WEBHOOK_SECRET }),
    ]) {
      const r = await call(req);
      expect(r.status).toBe(403);
      expect(await r.text()).toBe("");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ADAPTER_TOKEN 未設定なら誰も通さない", async () => {
    stubFetch();
    const r = await call(
      post("/obs-from/netdata/undefined", { alarm: "x" }),
      makeEnv({ ADAPTER_TOKEN: undefined }),
    );
    expect(r.status).toBe(403);
  });

  it("未知の adapter / 余計なパス → 404", async () => {
    stubFetch();
    for (const path of [
      `/obs-from/unknown/${ADAPTER_TOKEN}`,
      `/obs-from/constructor/${ADAPTER_TOKEN}`,
      `/obs-from/sentry/${ADAPTER_TOKEN}/extra`,
      "/obs-from",
      "/nope",
    ]) {
      const r = await call(post(path, {}, { "X-Adapter-Token": ADAPTER_TOKEN }));
      expect(r.status).toBe(404);
    }
  });

  it("Healthchecks の name 欠如 → 400 + [ConvertHealthchecks] で記録", async () => {
    const { notionCalls } = stubFetch();
    const r = await call(
      post("/obs-from/healthchecks", { status: "down" }, { "X-Adapter-Token": ADAPTER_TOKEN }),
    );
    expect(r.status).toBe(400);
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.subject.title[0].text.content).toBe("❌ obs-intake エラー (/obs-from/healthchecks)");
    expect(props.summary.rich_text[0].text.content).toContain("[ConvertHealthchecks]");
  });

  it("パスにトークンを付けて失敗しても、記録にトークンは残さない", async () => {
    const { notionCalls } = stubFetch();
    await call(post(`/obs-from/healthchecks/${ADAPTER_TOKEN}`, { status: "down" }));
    expect(JSON.stringify(notionCalls[0].json)).not.toContain(ADAPTER_TOKEN);
  });

  it("form-urlencoded の本文も読む (n8n の Webhook ノードと同じ)", async () => {
    const { notionCalls } = stubFetch();
    const r = await call(
      new Request("https://obs.example/obs-from/healthchecks", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Adapter-Token": ADAPTER_TOKEN,
        },
        body: "name=n8n-heartbeat&status=down&tags=n8n",
      }),
    );
    expect(r.status).toBe(200);
    expect(subjectOf(notionCalls[0].json)).toBe("⚠ n8n-heartbeat DOWN");
  });

  it("Grafana 12 件 → 10 件書いて 2 件は Queue", async () => {
    const { notionCalls } = stubFetch();
    const { queue, sent } = makeQueue();
    const alerts = Array.from({ length: 12 }, (_, i) => ({
      status: "firing",
      labels: { alertname: `Alert ${i}`, severity: "warning", host: "n8n-server" },
    }));
    const r = await call(
      post("/obs-from/grafana", { status: "firing", alerts }, { "X-Adapter-Token": ADAPTER_TOKEN }),
      makeEnv({ OBS_RETRY_QUEUE: queue }),
    );
    expect(await r.json()).toEqual({
      success: true,
      forwarded: true,
      items: 12,
      written: 10,
      queued: 2,
      failed: 0,
    });
    expect(notionCalls).toHaveLength(10);
    expect(sent).toHaveLength(2);
  });

  it("Netdata critical → Discord に @here、Notion に discord_channel", async () => {
    const { discordCalls, notionCalls } = stubFetch();
    const r = await call(
      post(
        "/obs-from/netdata",
        { alarm: "oom_kill", alarm_status: "CRITICAL", host: "n8n-server", info: "OOM" },
        { "X-Adapter-Token": ADAPTER_TOKEN },
      ),
    );
    expect(r.status).toBe(200);
    expect(discordCalls).toHaveLength(1);
    expect(discordCalls[0].json.content).toBe("@here");
    const props = notionCalls[0].json.properties as Record<string, any>;
    expect(props.discord_channel.select.name).toBe("obs-critical");
  });
});

describe("既存エンドポイント", () => {
  it("/health は認証なしで 200 のまま", async () => {
    const r = await call(new Request("https://obs.example/health"));
    expect(r.status).toBe(200);
  });

  it("/errors は READ_TOKEN の Bearer 認証のまま", async () => {
    const r = await call(new Request("https://obs.example/errors"));
    expect(r.status).toBe(401);
  });
});
