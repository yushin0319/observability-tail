/**
 * 受付エンドポイント・/errors の認証。
 * 比較は両方を SHA-256 にしてから全文字を XOR で見る (長さ・一致位置で時間が変わらない)。
 */
import { sha256Hex } from "./shared";

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/**
 * candidates のどれかが expected と一致すれば true。
 * expected (secret) が未設定なら常に false (設定漏れで素通しにしない)。
 */
export async function matchesSecret(
  candidates: (string | null | undefined)[],
  expected: string | undefined,
): Promise<boolean> {
  if (!expected) return false;
  let matched = false;
  for (const c of candidates) {
    if (!c) continue;
    // 早期 return せず全候補を比べる
    if (await timingSafeEqualString(c, expected)) matched = true;
  }
  return matched;
}
