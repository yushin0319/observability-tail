/**
 * Netdata (agent の custom_sender) → obs-notify payload。
 * n8n-server の code-nodes/api-obs-from-netdata/ConvertNetdata.ts を純関数にしたもの。
 */
import type { ObsNotifyPayload } from "../obsNotifyPayload";
import { HOST_TO_REPO as BASE_HOST_TO_REPO, HTTP_URL, lookup } from "../shared";
import type { JsonObject } from "../types";

const STATUS_TO_SEVERITY: Record<string, "critical" | "warning" | "info"> = {
  CRITICAL: "critical",
  WARNING: "warning",
  CLEAR: "info",
  REMOVED: "info",
  UNDEFINED: "warning",
  UNINITIALIZED: "warning",
};

const HOST_TO_REPO: Record<string, string> = {
  ...BASE_HOST_TO_REPO,
  "instance-20260206-1437": "n8n-server",
};

export function convertNetdata(input: unknown): ObsNotifyPayload[] {
  const body = (input as JsonObject) || ({} as JsonObject);

  const alarm =
    (body.alarm as string) ||
    (body.alert_name as string) ||
    (body.name as string) ||
    "";
  const host =
    (body.host as string) ||
    (body.host_name as string) ||
    (body.hostname as string) ||
    "";
  const statusRaw =
    (body.alarm_status as string) ||
    (body.status as string) ||
    (body.alert_state as string) ||
    "";
  const status = statusRaw.toUpperCase();
  const info = (body.info as string) || "";
  const valueString =
    (body.value_string as string) ||
    (body.alert_value_string as string) ||
    (body.value as string) ||
    "";
  const chart =
    (body.chart as string) ||
    (body.alarm_chart as string) ||
    (body.chart_context as string) ||
    "";
  const klass = (body.class as string) || (body.alert_class as string) || "";
  const rawUrl = (body.url as string) || (body.alarm_url as string) || "";

  // 空 payload / alarm 名抽出不可: warning で受け流して raw_payload 保持
  if (!alarm) {
    const out: ObsNotifyPayload = {
      severity: "warning",
      service: "netdata",
      subject: "⚠ Netdata unknown payload",
      summary:
        "ConvertNetdata が alarm 名を抽出できませんでした。raw_payload で形式を確認してください。",
      raw_payload: body,
    };
    return [out];
  }

  const severity = lookup(STATUS_TO_SEVERITY, status) ?? "warning";
  const emoji =
    severity === "critical" ? "🚨" : severity === "info" ? "✅" : "⚠";

  const subjectParts = [`${emoji} ${host || "?"} ${alarm}`];
  if (valueString) subjectParts.push(`= ${valueString}`);
  subjectParts.push(`(${status || "?"})`);
  const subject = subjectParts.join(" ");

  const summaryParts: string[] = [];
  if (info) summaryParts.push(info);
  if (chart) summaryParts.push(`chart=${chart}`);
  if (klass) summaryParts.push(`class=${klass}`);
  const summary = summaryParts.join(" / ");

  const out: ObsNotifyPayload = {
    severity,
    service: "netdata",
    subject,
    summary,
    raw_payload: body,
  };
  if (HTTP_URL.test(rawUrl)) out.url = rawUrl;
  const repo = lookup(HOST_TO_REPO, host);
  if (repo) out.repo = repo;
  return [out];
}
