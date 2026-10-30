/**
 * Grafana alerting webhook → obs-notify payload (alerts[] 1 件につき 1 payload)。
 * n8n-server の code-nodes/api-obs-from-grafana/ConvertGrafana.ts を純関数にしたもの。
 */
import type { ObsNotifyPayload } from "../obsNotifyPayload";
import { HOST_TO_REPO, HTTP_URL } from "../shared";
import type { JsonObject } from "../types";

const LABEL_TO_SEVERITY: Record<string, "critical" | "warning" | "info"> = {
  critical: "critical",
  error: "critical",
  warning: "warning",
  warn: "warning",
  info: "info",
};

type Alert = {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  generatorURL?: string;
  fingerprint?: string;
  startsAt?: string;
  endsAt?: string;
};

function convertOne(alert: Alert, rootStatus: string): ObsNotifyPayload {
  const labels = alert.labels || {};
  const annotations = alert.annotations || {};
  const alertname = labels.alertname || "Unknown alert";
  const host = labels.host || labels.hostname || labels.instance || "";
  const status = (alert.status || rootStatus || "firing").toLowerCase();
  const sevLabel = (labels.severity || "").toLowerCase();

  let severity: "critical" | "warning" | "info";
  if (status === "resolved") {
    severity = "info";
  } else {
    severity = LABEL_TO_SEVERITY[sevLabel] ?? "warning";
  }

  const emoji =
    status === "resolved" ? "✅" : severity === "critical" ? "🚨" : "🔥";
  const subjectParts = [`${emoji} ${alertname}`];
  if (host) subjectParts.push(`on ${host}`);
  subjectParts.push(`(${status})`);
  const subject = subjectParts.join(" ");

  const summaryParts: string[] = [];
  if (annotations.summary) summaryParts.push(annotations.summary);
  if (
    annotations.description &&
    annotations.description !== annotations.summary
  ) {
    summaryParts.push(annotations.description);
  }
  const labelHints = Object.entries(labels)
    .filter(([k]) => !["alertname", "severity"].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .slice(0, 4);
  if (labelHints.length > 0) summaryParts.push(labelHints.join(" "));
  const summary = summaryParts.join(" / ");

  const out: ObsNotifyPayload = {
    severity,
    service: "grafana",
    subject,
    summary,
    raw_payload: alert,
  };
  if (alert.generatorURL && HTTP_URL.test(alert.generatorURL)) {
    out.url = alert.generatorURL;
  }
  const repo = HOST_TO_REPO[host];
  if (repo) out.repo = repo;
  return out;
}

/** 1 リクエストで扱う Grafana アラートの上限 */
export const GRAFANA_MAX_ALERTS = 50;

/**
 * alerts[] を先頭 GRAFANA_MAX_ALERTS 件に切り詰める (変換前に切って CPU 時間を抑える)。
 * alerts[] が無い payload はそのまま返す (convertGrafana が unknown payload として記録する)。
 */
export function capGrafanaAlerts(input: unknown): { body: unknown; dropped: number } {
  const body = (input as JsonObject) || ({} as JsonObject);
  const alerts = body.alerts;
  if (!Array.isArray(alerts) || alerts.length <= GRAFANA_MAX_ALERTS) {
    return { body: input, dropped: 0 };
  }
  return {
    body: { ...body, alerts: alerts.slice(0, GRAFANA_MAX_ALERTS) },
    dropped: alerts.length - GRAFANA_MAX_ALERTS,
  };
}

export function convertGrafana(input: unknown): ObsNotifyPayload[] {
  const body = (input as JsonObject) || ({} as JsonObject);
  const alerts = (body.alerts as Alert[] | undefined) || [];
  const rootStatus = (body.status as string) || "firing";

  if (!Array.isArray(alerts) || alerts.length === 0) {
    const out: ObsNotifyPayload = {
      severity: "warning",
      service: "grafana",
      subject: "⚠ Grafana unknown payload (no alerts[])",
      summary:
        "ConvertGrafana が alerts[] を抽出できませんでした。raw_payload で形式を確認してください。",
      raw_payload: body,
    };
    return [out];
  }

  return alerts.map((a) => convertOne(a, rootStatus));
}
