/**
 * Sentry webhook → obs-notify payload。
 * n8n-server の code-nodes/api-obs-from-sentry/ConvertSentry.ts を純関数にしたもの。
 */
import type { ObsNotifyPayload } from "../obsNotifyPayload";
import type { JsonObject } from "../types";

/** Sentry project slug → repo 名のマッピング */
const PROJECT_TO_REPO: Record<string, string> = {
  shirankedo: "shirankedo",
  "worldpulse-api": "WorldPulse",
  "swipe-persona-api": "swipe-persona",
  "crypto-ai-trader-runner": "crypto-ai-trader",
  "n8n-server": "n8n-server",
};

const LEVEL_TO_SEVERITY: Record<string, "critical" | "warning" | "info"> = {
  fatal: "critical",
  error: "warning",
  warning: "warning",
  info: "info",
  debug: "info",
};

export function convertSentry(input: unknown): ObsNotifyPayload[] {
  const body = (input as JsonObject) || ({} as JsonObject);
  const data = (body.data as JsonObject) || {};
  const issue = (data.issue as JsonObject) || {};
  const event = (data.event as JsonObject) || {};
  const errorObj = (data.error as JsonObject) || {};
  const issueMeta = (issue.metadata as JsonObject | undefined) || {};
  const eventMeta = (event.metadata as JsonObject | undefined) || {};
  const errorMeta = (errorObj.metadata as JsonObject | undefined) || {};

  const title =
    (issue.title as string) ||
    (event.title as string) ||
    (errorObj.title as string) ||
    (issueMeta.value as string) ||
    (eventMeta.value as string) ||
    (errorMeta.value as string) ||
    (issueMeta.type as string) ||
    (eventMeta.type as string) ||
    (errorMeta.type as string) ||
    "";

  const level =
    (issue.level as string) ||
    (event.level as string) ||
    (errorObj.level as string) ||
    "error";
  const url =
    (issue.permalink as string) ||
    (event.web_url as string) ||
    (event.url as string) ||
    (errorObj.web_url as string) ||
    (errorObj.url as string) ||
    "";
  const projectSlug =
    ((issue.project as JsonObject | undefined)?.slug as string) ||
    (event.project_slug as string) ||
    (errorObj.project_slug as string) ||
    "";
  const repo = PROJECT_TO_REPO[projectSlug];

  if (!title) {
    // 想定外の Sentry payload 形式: throw せず warning で受け流して人間が判別できる
    // subject + raw_payload で Notion DB に残す。後で adapter に対応形式を追加する判断材料に。
    const action = (body.action as string) || "unknown";
    const id =
      (issue.id as string) ||
      (event.event_id as string) ||
      (errorObj.event_id as string) ||
      "?";
    const out: ObsNotifyPayload = {
      severity: "warning",
      service: "sentry",
      subject: `⚠ Sentry unknown event payload (action=${action}, id=${id})`,
      summary:
        "ConvertSentry が title を抽出できませんでした。raw_payload で形式を確認してください。",
      raw_payload: body,
    };
    if (repo) out.repo = repo;
    return [out];
  }

  const baseSeverity = LEVEL_TO_SEVERITY[level] ?? "warning";
  // 慢性ベースライン: 1GB OCI Micro の EventLoopBlocked は体力不足由来の非アクショナブル
  // 症状 (恒久策は A1-flex 移行 = Notion task #477)。#obs-warning の ping を止めるため
  // info に格下げする。観測性 DB (Notion) に記録は残るので追跡は可能。
  const isEventLoopBlocked = /event\s*loop\s*blocked/i.test(title);
  const severity = isEventLoopBlocked ? "info" : baseSeverity;
  const out: ObsNotifyPayload = {
    severity,
    service: "sentry",
    subject: `🐛 ${title}`,
    summary: `level=${level} project=${projectSlug || "unknown"}`,
    raw_payload: body,
  };
  if (url) out.url = url;
  if (repo) out.repo = repo;
  return [out];
}
