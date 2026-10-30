/** n8n-server code-nodes/_shared/obsNotifyPayload.test.ts の移植 */
import { describe, expect, it } from "vitest";
import { obsNotifyFromCron } from "./obsNotifyPayload";

describe("obsNotifyFromCron", () => {
  it("正常系: severity=info / 絵文字付き subject / detail を summary に", () => {
    const p = obsNotifyFromCron({
      label: "shirankedo 記事更新完了",
      isError: false,
      detail: "5件追加",
      service: "n8n",
      repo: "shirankedo",
    });
    expect(p.severity).toBe("info");
    expect(p.subject).toBe("✅ shirankedo 記事更新完了");
    expect(p.summary).toBe("5件追加");
    expect(p.service).toBe("n8n");
    expect(p.repo).toBe("shirankedo");
  });

  it("エラー時: severity=warning / ❌ 絵文字 / summary に エラー prefix", () => {
    const p = obsNotifyFromCron({
      label: "shirankedo 記事更新完了",
      isError: true,
      detail: "HTTP 500",
      service: "n8n",
      repo: "shirankedo",
    });
    expect(p.severity).toBe("warning");
    expect(p.subject).toBe("❌ shirankedo 記事更新完了");
    expect(p.summary).toBe("エラー: HTTP 500");
  });

  it("detail が空でも subject は出力", () => {
    const p = obsNotifyFromCron({
      label: "heartbeat",
      isError: false,
      service: "n8n",
    });
    expect(p.subject).toBe("✅ heartbeat");
    expect(p.summary).toBe("");
  });

  it("raw_payload / url 任意", () => {
    const p = obsNotifyFromCron({
      label: "foo",
      isError: true,
      detail: "boom",
      service: "n8n",
      repo: "n8n-server",
      url: "https://example.com/run/1",
      raw_payload: { code: 500 },
    });
    expect(p.url).toBe("https://example.com/run/1");
    expect(p.raw_payload).toEqual({ code: 500 });
  });

  it("severity 上書き: critical を明示できる (system-error-handler 用)", () => {
    const p = obsNotifyFromCron({
      label: "n8n WF クラッシュ",
      isError: true,
      detail: "EventLoopBlocked",
      service: "n8n",
      severity: "critical",
    });
    expect(p.severity).toBe("critical");
  });
});
