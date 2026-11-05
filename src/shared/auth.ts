/**
 * Linkexのページの localStorage から拾ったログイン情報の入れ物（キーと値）を見て、
 * ログインしているかを判定する。値のトークンは、ページ側で中身を伏せてから渡す。
 *
 * Linkexは保存のしかたを変えることがある（linkex_credentials → linkex_user_cache_v1 の中）。
 * 読めない形のときは null（分からない）を返し、ログイン切れと決めつけて全体を止めないようにする。
 */
export function judgeLogin(entries: [string, string][]): boolean | null {
  let result: boolean | null = null;
  for (const [key, raw] of entries) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue; // 読めない形
    }
    const credentials = /credential/i.test(key) ? value : findKey(value, 'credentials');
    const found = credentials === undefined ? false : hasToken(credentials);
    if (found) return true;
    result = false;
  }
  return result;
}

/** 入れ子の中から、指定した名前のキーの値を探す */
function findKey(value: unknown, name: string, depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  const obj = value as Record<string, unknown>;
  if (name in obj) return obj[name];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, name, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 空でないトークンを持っているか */
function hasToken(value: unknown): boolean {
  const token = findKey(value, 'token');
  return typeof token === 'string' && token.length > 0;
}
