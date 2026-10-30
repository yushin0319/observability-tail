/**
 * Healthchecks.io webhook → obs-notify payload。
 * n8n-server の code-nodes/api-obs-from-healthchecks/ConvertHealthchecks.ts を純関数にしたもの。
 */
import type { ObsNotifyPayload } from "../obsNotifyPayload";
import { ObsPayloadError } from "../prepNotify";
import { HTTP_URL } from "../shared";
import type { JsonObject } from "../types";

export function convertHealthchecks(input: unknown): ObsNotifyPayload[] {
  const body = (input as JsonObject) || ({} as JsonObject);
  const name = body.name as string;
  const status = (body.status as string) || "down";
  const url = body.url as string | undefined;

  if (!name) {
    throw new ObsPayloadError("Healthchecks payload missing 'name'");
  }

  const severity: "critical" | "warning" | "info" =
    status === "down" ? "warning" : status === "up" ? "info" : "warning";

  const subject = severity === "info" ? `✅ ${name} UP` : `⚠ ${name} DOWN`;

  const out: ObsNotifyPayload = {
    severity,
    service: "healthchecks",
    subject,
    summary: `status=${status} tags=${(body.tags as string) || ""}`,
    raw_payload: body,
  };
  // HC.io の Webhook body template で `$URL` を含めても、check 自身に URL 未設定だと
  // placeholder が展開されず文字列 "$URL" がそのまま送られてくる。non-http(s) は弾く。
  if (url && HTTP_URL.test(url)) out.url = url;

  return [out];
}
