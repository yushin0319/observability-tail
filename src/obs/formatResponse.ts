/**
 * obs-notify の応答 JSON を組み立てる。
 * n8n-server の code-nodes/api-obs-notify/FormatResponse.ts を純関数にしたもの。
 * 入力は n8n の各ノード出力と同じ形:
 * - discordRes: SendDiscord (fullResponse) の出力 = { statusCode } / 通信失敗時 { error }。
 *   送信していない (sendDiscordNow=false) ときは null。
 * - notion: CreateNotionPage の出力 = 作成したページ / 再試行を使い切ったとき { error: { httpCode } }。
 */
import type { JsonObject } from "./types";

export interface PrepSummary {
  severity: string;
  service: string;
  channel: string;
  sendDiscordNow: boolean;
}

export interface DiscordStatus {
  ok: boolean;
  status: number | null;
  skipped?: true;
  /** 60 秒以内に同じ critical を送っていたので鳴らさなかったとき true */
  deduplicated?: true;
}

export interface NotionStatus {
  ok: boolean;
  page_id: string | null;
  error_code: string | null;
  /** Notion に書けず再送キューに積んだとき true */
  queued?: true;
}

export interface ObsNotifyResponse {
  success: boolean;
  severity: string;
  service: string;
  channel: string;
  discord: DiscordStatus;
  notion: NotionStatus;
}

export function formatResponse(
  prep: PrepSummary,
  discordRes: JsonObject | null,
  notion: JsonObject,
): ObsNotifyResponse {
  // critical 以外は Discord に送らない。critical なのに送らなかった = URL 未設定で
  // 起こすべき通知が出ていないので ok=false にする。
  let discord: DiscordStatus;
  if (prep.sendDiscordNow === true) {
    const res = discordRes ?? {};
    const status = typeof res.statusCode === "number" ? res.statusCode : null;
    discord = { ok: status !== null && status >= 200 && status < 300, status };
  } else {
    discord = { ok: prep.severity !== "critical", status: null, skipped: true };
  }
  const notionOk = notion.object !== "error" && Boolean(notion.id);
  // 再試行を使い切ると Notion の本文ではなく { error: <失敗理由> } が来るので、HTTP コードをそこから拾う。
  const failure = (notion.error ?? {}) as JsonObject;
  const httpCode = failure.httpCode ?? failure.statusCode ?? null;
  const errorCode =
    notion.code ?? (httpCode === null ? null : String(httpCode));

  return {
    success: discord.ok === true && notionOk,
    severity: prep.severity,
    service: prep.service,
    channel: prep.channel,
    discord,
    notion: {
      ok: notionOk,
      page_id: (notion.id as string | undefined) ?? null,
      error_code: notionOk ? null : (errorCode as string | null),
    },
  };
}
