/**
 * obs-notify への入力 payload。n8n-server の code-nodes/_shared/obsNotifyPayload.ts と同じ。
 */
export interface ObsNotifyPayload {
  severity: "critical" | "warning" | "info";
  service: string;
  subject: string;
  summary?: string;
  repo?: string;
  url?: string;
  raw_payload?: unknown;
}

export function obsNotifyFromCron(params: {
  label: string;
  isError: boolean;
  detail?: string;
  service: string;
  repo?: string;
  url?: string;
  raw_payload?: unknown;
  severity?: "critical" | "warning" | "info";
}): ObsNotifyPayload {
  const severity = params.severity ?? (params.isError ? "warning" : "info");
  const emoji = params.isError ? "❌" : "✅";
  const subject = `${emoji} ${params.label}`;
  const summary = params.detail
    ? params.isError
      ? `エラー: ${params.detail}`
      : params.detail
    : "";
  return {
    severity,
    service: params.service,
    subject,
    summary,
    repo: params.repo,
    url: params.url,
    raw_payload: params.raw_payload,
  };
}
