/**
 * n8n-server code-nodes/api-obs-notify/FormatResponse.test.ts の移植。
 * $("PrepNotify") / $("SendDiscord") / $input の stub は引数に置き換えた
 * (SendDiscord を通らなかった実行 = discordRes に null)。
 */
import { describe, expect, it } from "vitest";
import { formatResponse, type PrepSummary } from "./formatResponse";

const prepStub: PrepSummary = {
  severity: "critical",
  service: "n8n",
  channel: "obs-critical",
  sendDiscordNow: true,
};

const prepDiscordSkipped: PrepSummary = {
  ...prepStub,
  severity: "warning",
  sendDiscordNow: false,
};

describe("formatResponse", () => {
  it("両方成功: success=true / Discord と Notion の status を返す", () => {
    const out = formatResponse(
      prepStub,
      { statusCode: 204 },
      { object: "page", id: "page-123" },
    );
    expect(out.success).toBe(true);
    expect(out.discord).toEqual({ ok: true, status: 204 });
    expect(out.notion).toEqual({
      ok: true,
      page_id: "page-123",
      error_code: null,
    });
    expect(out.severity).toBe("critical");
    expect(out.service).toBe("n8n");
    expect(out.channel).toBe("obs-critical");
  });

  it("Discord 200 OK / Notion 失敗 → success=false", () => {
    const out = formatResponse(
      prepStub,
      { statusCode: 200 },
      { object: "error", code: "validation_error" },
    );
    expect(out.success).toBe(false);
    expect(out.notion).toEqual({
      ok: false,
      page_id: null,
      error_code: "validation_error",
    });
  });

  it("Discord 4xx / Notion 成功 → success=false (4xx は ok=false)", () => {
    const out = formatResponse(
      prepStub,
      { statusCode: 429 },
      { object: "page", id: "p" },
    );
    expect(out.success).toBe(false);
    expect(out.discord).toEqual({ ok: false, status: 429 });
  });

  it("Discord 5xx / Notion 成功 → success=false", () => {
    const out = formatResponse(
      prepStub,
      { statusCode: 500 },
      { object: "page", id: "p" },
    );
    expect(out.success).toBe(false);
    expect(out.discord).toEqual({ ok: false, status: 500 });
  });

  it("Discord ネットワーク error (statusCode なし) → success=false", () => {
    const out = formatResponse(
      prepStub,
      { error: "timeout" },
      { object: "page", id: "p" },
    );
    expect(out.success).toBe(false);
    expect(out.discord).toEqual({ ok: false, status: null });
  });

  it("両方失敗 → success=false", () => {
    const out = formatResponse(
      prepStub,
      { error: "timeout" },
      { object: "error", code: "rate_limited" },
    );
    expect(out.success).toBe(false);
  });

  it("Discord 送信スキップ + Notion 成功 → success=true / skipped=true", () => {
    const out = formatResponse(prepDiscordSkipped, null, {
      object: "page",
      id: "page-9",
    });
    expect(out.success).toBe(true);
    expect(out.discord).toEqual({ ok: true, status: null, skipped: true });
    expect(out.notion).toEqual({
      ok: true,
      page_id: "page-9",
      error_code: null,
    });
  });

  it("Discord 送信スキップ + Notion 失敗 → success=false", () => {
    const out = formatResponse(prepDiscordSkipped, null, {
      object: "error",
      code: "validation_error",
    });
    expect(out.success).toBe(false);
  });

  // 再試行を使い切ると { error: <失敗理由> } が 1 件来る
  it("Notion 再試行後も 5xx → ok=false / error_code に HTTP コード (httpCode)", () => {
    const out = formatResponse(prepDiscordSkipped, null, {
      error: {
        httpCode: "500",
        message: "Cross-cell memcached access is not allowed",
      },
    });
    expect(out.success).toBe(false);
    expect(out.notion).toEqual({
      ok: false,
      page_id: null,
      error_code: "500",
    });
  });

  it("Notion 再試行後も失敗 (statusCode のみ) → error_code に HTTP コード", () => {
    const out = formatResponse(prepDiscordSkipped, null, {
      error: { statusCode: 503, message: "x" },
    });
    expect(out.notion).toEqual({
      ok: false,
      page_id: null,
      error_code: "503",
    });
  });

  it("Notion がネットワークエラー (HTTP コードなし) → error_code=null", () => {
    const out = formatResponse(prepDiscordSkipped, null, {
      error: { message: "socket hang up" },
    });
    expect(out.notion).toEqual({
      ok: false,
      page_id: null,
      error_code: null,
    });
  });

  it("critical なのに送信できなかった (URL 未設定) → success=false", () => {
    const out = formatResponse({ ...prepStub, sendDiscordNow: false }, null, {
      object: "page",
      id: "p",
    });
    expect(out.success).toBe(false);
    expect(out.discord).toEqual({ ok: false, status: null, skipped: true });
  });
});
