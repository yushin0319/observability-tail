/**
 * 受付エンドポイントの認証。
 * 比較は両方を SHA-256 にしてから全バイトを XOR で見る (長さ・一致位置で時間が変わらない)。
 */

async function digest(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

export async function timingSafeEqualString(
  a: string,
  b: string,
): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
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
