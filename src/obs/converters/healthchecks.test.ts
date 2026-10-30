/** n8n-server code-nodes/api-obs-from-healthchecks/ConvertHealthchecks.test.ts の移植 */
import { describe, expect, it } from "vitest";
import { ObsPayloadError } from "../prepNotify";
import { convertHealthchecks } from "./healthchecks";

describe("convertHealthchecks", () => {
  it("status=down → severity=warning / subject に check name", () => {
    const [out] = convertHealthchecks({
      name: "shirankedo-daily-articles",
      status: "down",
      tags: "n8n cron",
      url: "https://healthchecks.io/checks/abc/details/",
    });
    expect(out.severity).toBe("warning");
    expect(out.service).toBe("healthchecks");
    expect(out.subject).toContain("shirankedo-daily-articles");
    expect(out.subject).toContain("DOWN");
    expect(out.url).toBe("https://healthchecks.io/checks/abc/details/");
  });

  it("status=up → severity=info", () => {
    const [out] = convertHealthchecks({ name: "x", status: "up" });
    expect(out.severity).toBe("info");
  });

  it("name 欠如で throw", () => {
    expect(() => convertHealthchecks({ status: "down" })).toThrow(
      ObsPayloadError,
    );
  });

  it("url が未展開 placeholder ($URL) なら omit する", () => {
    const [out] = convertHealthchecks({
      name: "n8n-error-handler",
      status: "up",
      tags: "n8n cron",
      url: "$URL",
    });
    expect(out.url).toBeUndefined();
  });

  it("url が http(s) で始まる場合のみ通す", () => {
    const [out] = convertHealthchecks({
      name: "x",
      status: "down",
      url: "ftp://invalid",
    });
    expect(out.url).toBeUndefined();
  });
});
