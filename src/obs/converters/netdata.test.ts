/** n8n-server code-nodes/api-obs-from-netdata/ConvertNetdata.test.ts の移植 */
import { describe, expect, it } from "vitest";
import { convertNetdata } from "./netdata";

describe("convertNetdata", () => {
  it("CRITICAL status → severity=critical / subject に emoji", () => {
    const [out] = convertNetdata({
      alarm: "system_post_update_reboot_status",
      alarm_status: "CRITICAL",
      host: "instance-20260206-1437",
      info: "System requires reboot after package updates",
      value_string: "1 status",
      chart: "system.post_update_reboot_status",
      class: "Errors",
      url: "https://app.netdata.cloud/spaces/yushin-infra",
    });
    expect(out.severity).toBe("critical");
    expect(out.service).toBe("netdata");
    expect(out.subject).toContain("🚨");
    expect(out.subject).toContain("system_post_update_reboot_status");
    expect(out.url).toBe("https://app.netdata.cloud/spaces/yushin-infra");
    expect(out.repo).toBe("n8n-server");
  });

  it("WARNING status → severity=warning", () => {
    const [out] = convertNetdata({
      alarm: "10min_received_packets_dropped",
      alarm_status: "WARNING",
      host: "n8n-server",
      info: "packets dropped",
      value_string: "100 packets",
    });
    expect(out.severity).toBe("warning");
    expect(out.subject).toContain("⚠");
  });

  it("CLEAR status → severity=info", () => {
    const [out] = convertNetdata({
      alarm: "web_log_1m_successful",
      alarm_status: "CLEAR",
      host: "n8n-server",
      value_string: "98%",
    });
    expect(out.severity).toBe("info");
    expect(out.subject).toContain("✅");
  });

  it("javascript:// 等の non-http URL は弾く", () => {
    const [out] = convertNetdata({
      alarm: "x",
      alarm_status: "WARNING",
      host: "n8n-server",
      url: "javascript:alert(1)",
    });
    expect(out.url).toBeUndefined();
  });

  it("alarm 名抽出不可 → severity=warning + raw_payload 保持", () => {
    const [out] = convertNetdata({ foo: "bar" });
    expect(out.severity).toBe("warning");
    expect(out.subject).toContain("Netdata unknown payload");
    expect(out.raw_payload).toEqual({ foo: "bar" });
  });

  it("空 body でも throw せず warning で受け流す", () => {
    const [out] = convertNetdata({});
    expect(out.severity).toBe("warning");
    expect(out.subject).toContain("Netdata unknown payload");
  });

  it("alert_name / status / host_name の別名フィールドも拾う", () => {
    const [out] = convertNetdata({
      alert_name: "20min_steal_cpu",
      status: "warning",
      host_name: "crypto-ai-trader",
      alert_value_string: "12%",
    });
    expect(out.severity).toBe("warning");
    expect(out.subject).toContain("20min_steal_cpu");
    expect(out.repo).toBe("crypto-ai-trader");
  });

  it.each(["constructor", "__proto__", "toString"])(
    "host %s は対応表の組み込みのキーに当たらない (repo なし)",
    (key) => {
      const [out] = convertNetdata({ alarm: "x", alarm_status: "WARNING", host: key });
      expect(out.repo).toBeUndefined();
    },
  );
});
