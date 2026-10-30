/**
 * 受け口・tail・変換で共有する小さな道具。
 */

/** 同じ通知を繰り返さない時間 (tail のエラー通知・critical の Discord 通知で共通) */
export const DEDUP_TTL_SEC = 60;

/** http(s) の URL だけ通す */
export const HTTP_URL = /^https?:\/\//;

/** ホスト名 → repo 名 (Grafana / Netdata の変換で共有) */
export const HOST_TO_REPO: Readonly<Record<string, string>> = {
  "n8n-server": "n8n-server",
  "crypto-ai-trader": "crypto-ai-trader",
  "crypto-ai-trader-runner": "crypto-ai-trader",
};

/** SHA-256 の先頭 bytes バイトを 16 進文字列で返す (KV のキー長を変えないよう呼び出し側で長さを決める) */
export async function sha256Hex(s: string, bytes = 32): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * key に印が無ければ付けて true (この呼び出しが送ってよい)、既にあれば false。
 * KV の失敗はそのまま投げる (どう扱うかは呼び出し側が決める)。
 */
export async function claimOnce(kv: KVNamespace, key: string): Promise<boolean> {
  if ((await kv.get(key)) !== null) return false;
  await kv.put(key, "1", { expirationTtl: DEDUP_TTL_SEC });
  return true;
}

/** claimOnce で付けた印を外す (送れなかったときに、次の同じ通知で送り直せるように) */
export async function release(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}
