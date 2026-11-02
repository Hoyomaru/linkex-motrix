/**
 * 共有URLまたはトークンから共有トークンを取り出す。
 * 対応: https://www.linkex.io/f/<token>, https://linkex.io/f/<token>,
 *       https://l2e.click/d/<token>, トークンそのもの
 */
export function parseShareToken(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^[A-Za-z0-9_-]{4,64}$/.test(text)) return text;
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\./, '');
    if (host !== 'linkex.io' && host !== 'l2e.click') return null;
    const match = url.pathname.match(/^\/(?:f|d|s)\/([A-Za-z0-9_-]{4,64})\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** 改行・空白区切りの複数URLからトークンを重複なしで取り出す */
export function parseShareTokens(input: string): { tokens: string[]; invalid: string[] } {
  const tokens: string[] = [];
  const invalid: string[] = [];
  for (const part of input.split(/\s+/)) {
    if (!part) continue;
    const token = parseShareToken(part);
    if (token) {
      if (!tokens.includes(token)) tokens.push(token);
    } else {
      invalid.push(part);
    }
  }
  return { tokens, invalid };
}
