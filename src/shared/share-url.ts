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

/**
 * 文章の中から共有URLだけを拾う（右クリックで選んだ文字・ページ内のリンク収集用）。
 * トークンだけの単語は普通の言葉と区別できないので拾わない。
 */
export function extractShareUrls(text: string): string[] {
  const pattern = /(?:https?:\/\/)?(?:www\.)?(?:linkex\.io|l2e\.click)\/(?:f|d|s)\/[A-Za-z0-9_-]{4,64}/gi;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const url = /^https?:/i.test(match[0]) ? match[0] : `https://${match[0]}`;
    const token = parseShareToken(url);
    if (token && !seen.has(token)) {
      seen.add(token);
      urls.push(url);
    }
  }
  return urls;
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
