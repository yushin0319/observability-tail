/** n8n-server code-nodes/api-obs-from-grafana/ConvertGrafana.test.ts の移植 */
import { describe, expect, it } from "vitest";
import { convertGrafana } from "./grafana";

describe("convertGrafana", () => {
  it("firing + labels.severity=warning → warning / repo を host から推定", () => {
    const items = convertGrafana({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "Loki ERROR burst",
            host: "n8n-server",
            severity: "warning",
            unit: "docker.service",
          },
          annotations: {
            summary: "Loki ERROR burst on n8n-server",
            description: "Error count >= 10 in 5m",
          },
          generatorURL: "https://yushinfudo1986.grafana.net/alerting/...",
        },
      ],
    });
    expect(items.length).toBe(1);
    const out = items[0];
    expect(out.severity).toBe("warning");
    expect(out.service).toBe("grafana");
    expect(out.subject).toContain("🔥");
    expect(out.subject).toContain("Loki ERROR burst");
    expect(out.subject).toContain("n8n-server");
    expect(out.url).toBe("https://yushinfudo1986.grafana.net/alerting/...");
    expect(out.repo).toBe("n8n-server");
    expect(out.summary).toContain("Loki ERROR burst on n8n-server");
  });

  it("status=resolved → severity=info (labels.severity に関わらず)", () => {
    const [out] = convertGrafana({
      status: "resolved",
      alerts: [
        {
          status: "resolved",
          labels: {
            alertname: "Loki ERROR burst",
            severity: "critical",
            host: "n8n-server",
          },
          annotations: {},
        },
      ],
    });
    expect(out.severity).toBe("info");
    expect(out.subject).toContain("✅");
    expect(out.subject).toContain("resolved");
  });

  it("labels.severity=critical → severity=critical", () => {
    const [out] = convertGrafana({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "Disk full",
            severity: "critical",
            host: "n8n-server",
          },
        },
      ],
    });
    expect(out.severity).toBe("critical");
    expect(out.subject).toContain("🚨");
  });

  it("labels.severity 不明 → warning (firing デフォルト)", () => {
    const [out] = convertGrafana({
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "Foo" } }],
    });
    expect(out.severity).toBe("warning");
  });

  it("alerts[] が複数件 → 複数 payload を返す", () => {
    const items = convertGrafana({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "A", severity: "warning", host: "n8n-server" },
        },
        {
          status: "firing",
          labels: {
            alertname: "B",
            severity: "critical",
            host: "crypto-ai-trader",
          },
        },
      ],
    });
    expect(items.length).toBe(2);
    expect(items[0].subject).toContain("A");
    expect(items[1].subject).toContain("B");
    expect(items[1].severity).toBe("critical");
  });

  it("alerts[] が空 → severity=warning unknown payload", () => {
    const [out] = convertGrafana({ status: "firing", alerts: [] });
    expect(out.severity).toBe("warning");
    expect(out.subject).toContain("Grafana unknown payload");
    expect(out.raw_payload).toEqual({ status: "firing", alerts: [] });
  });

  it("javascript:// 等の non-http generatorURL は弾く", () => {
    const [out] = convertGrafana({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "X", severity: "warning" },
          generatorURL: "javascript:alert(1)",
        },
      ],
    });
    expect(out.url).toBeUndefined();
  });

  it("空 body でも throw せず warning unknown payload で受け流す", () => {
    const [out] = convertGrafana({});
    expect(out.severity).toBe("warning");
    expect(out.subject).toContain("Grafana unknown payload");
  });
});
