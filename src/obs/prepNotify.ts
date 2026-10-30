/**
 * obs-notify の入力検証と Discord / Notion リクエスト本文の組み立て。
 * n8n-server の code-nodes/api-obs-notify/PrepNotify.ts を純関数にしたもの。
 * 許可リスト・文字数制限・url 検証・Notion プロパティ対応は n8n 側と同じ。
 */
import type { JsonObject } from "./types";

export const OBS_DB_ID = "3552570f-e49f-80a6-9186-c1a14b7d9547";
const NOTION_TEXT_LIMIT = 2000;
const DISCORD_TITLE_LIMIT = 256;
const DISCORD_DESC_LIMIT = 4096;

const COLOR_MAP: Record<string, number> = {
  critical: 0xe74c3c,
  warning: 0xf1c40f,
  info: 0x3498db,
};

const ALLOWED_SEVERITY = ["critical", "warning", "info"];

const ALLOWED_SERVICE = [
  "n8n",
  "observability-tail",
  "cf-worker",
  "crypto-ai-trader",
  "sentry",
  "healthchecks",
  "uptime-kuma",
  "netdata",
  "grafana",
  "github-actions",
];

const ALLOWED_REPO = [
  "n8n-server",
  "shirankedo",
  "WorldPulse",
  "swipe-persona",
  "crypto-ai-trader",
  "observability-tail",
  "kakuho",
  "dotclaude",
  "multi-agent",
];

/** 送り元の payload が不正なときに投げる (HTTP では 400 にする) */
export class ObsPayloadError extends Error {
  override name = "ObsPayloadError";
}

export type NotionPageBody = {
  parent: { database_id: string };
  properties: JsonObject;
};

export interface PreparedNotify {
  severity: string;
  service: string;
  subject: string;
  channel: string;
  discordUrl: string;
  sendDiscordNow: boolean;
  discordBody: JsonObject;
  notionBody: NotionPageBody;
}

export interface PrepOptions {
  /** critical を即時に送る Discord webhook URL (secret DISCORD_CRITICAL_URL) */
  discordCriticalUrl?: string;
}

export function prepNotify(
  input: unknown,
  opts: PrepOptions = {},
): PreparedNotify {
  const body = (input as JsonObject) || ({} as JsonObject);
  const severity = body.severity as string;
  const service = body.service as string;
  const subject = body.subject as string;
  const repo = (body.repo as string) || "";

  if (!ALLOWED_SEVERITY.includes(severity)) {
    throw new ObsPayloadError(
      `severity must be one of: ${ALLOWED_SEVERITY.join(" | ")}`,
    );
  }
  if (!ALLOWED_SERVICE.includes(service)) {
    throw new ObsPayloadError(
      `service must be one of: ${ALLOWED_SERVICE.join(" | ")}`,
    );
  }
  if (typeof subject !== "string" || !subject) {
    throw new ObsPayloadError("subject is required (string)");
  }
  if (repo && !ALLOWED_REPO.includes(repo)) {
    throw new ObsPayloadError(`repo must be one of: ${ALLOWED_REPO.join(" | ")}`);
  }

  const channel = `obs-${severity}`;
  // 即時の Discord 送信は critical のみ。warning は cron/obs-daily-digest が
  // 毎日 23:00 JST に 1 通へまとめ、info は Notion 記録のみ（Discord 通知過多の是正）。
  // URL 未設定なら送らない（空 URL に POST しない）。
  const discordUrl =
    severity === "critical" && opts.discordCriticalUrl
      ? opts.discordCriticalUrl
      : "";
  const sendDiscordNow = severity === "critical" && discordUrl !== "";

  const summary = (body.summary as string) || "";
  const rawUrl = (body.url as string) || "";
  // adapter 側のガード漏れに備えた二重保険: 非 http(s) URL は Discord/Notion 共に弾く。
  const url = /^https?:\/\//.test(rawUrl) ? rawUrl : "";
  const rawPayload = body.raw_payload;
  const rawPayloadStr =
    typeof rawPayload === "string"
      ? rawPayload
      : rawPayload === undefined || rawPayload === null
        ? ""
        : JSON.stringify(rawPayload);

  const timestampIso = new Date().toISOString();

  const discordEmbed: JsonObject = {
    title: subject.slice(0, DISCORD_TITLE_LIMIT),
    description: summary.slice(0, DISCORD_DESC_LIMIT),
    color: COLOR_MAP[severity],
    timestamp: timestampIso,
    footer: { text: `${service}${repo ? ` · ${repo}` : ""}` },
  };
  if (url) discordEmbed.url = url;

  const discordBody: JsonObject = { embeds: [discordEmbed] };
  if (severity === "critical") discordBody.content = "@here";

  const notionProps: JsonObject = {
    subject: {
      title: [{ text: { content: subject.slice(0, NOTION_TEXT_LIMIT) } }],
    },
    severity: { select: { name: severity } },
    service: { select: { name: service } },
    timestamp: { date: { start: timestampIso } },
  };
  // 即時送信の対象だけ送信先を入れる。実際に送れなかったときは
  // process.ts の withoutDiscordChannel で外してから書き込む。
  if (sendDiscordNow)
    notionProps.discord_channel = { select: { name: channel } };
  if (repo) notionProps.repo = { select: { name: repo } };
  if (summary) {
    notionProps.summary = {
      rich_text: [{ text: { content: summary.slice(0, NOTION_TEXT_LIMIT) } }],
    };
  }
  if (rawPayloadStr) {
    notionProps.raw_payload = {
      rich_text: [
        { text: { content: rawPayloadStr.slice(0, NOTION_TEXT_LIMIT) } },
      ],
    };
  }
  if (url) notionProps.url = { url };

  const notionBody: NotionPageBody = {
    parent: { database_id: OBS_DB_ID },
    properties: notionProps,
  };

  return {
    severity,
    service,
    subject,
    channel,
    discordUrl,
    sendDiscordNow,
    discordBody,
    notionBody,
  };
}
