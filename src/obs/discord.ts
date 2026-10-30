/**
 * critical の即時通知 (Discord webhook)。
 * 戻り値は n8n の SendDiscord (fullResponse + neverError) の出力と同じ形にそろえ、
 * formatResponse にそのまま渡せるようにする: 応答があれば { statusCode }、通信失敗は { error }。
 */
import { fetchWithTimeout } from "./budget";
import type { JsonObject } from "./types";

export async function sendDiscord(
  url: string,
  body: JsonObject,
): Promise<JsonObject> {
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 接続を解放するため本文は読み捨てる
    await resp.text().catch(() => "");
    return { statusCode: resp.status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function isDiscordOk(res: JsonObject | null): boolean {
  const status = res?.statusCode;
  return typeof status === "number" && status >= 200 && status < 300;
}
