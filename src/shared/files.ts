/** 一覧の要素は { file: {...} } の形と、ファイルそのものの形がある */
export function unwrapFile(item: any): any {
  return item && typeof item === 'object' && item.file && typeof item.file === 'object' ? item.file : item;
}

export function isFolder(file: any): boolean {
  const t = String(file?.type ?? file?.fileType ?? '').toLowerCase();
  return t === 'folder' || t === 'dir' || file?.isDir === true || file?.isFolder === true;
}

/** 中身のハッシュ（重複判定に使う）。例: f4c8e2..._36766 */
export function contentHash(file: any): string | null {
  const h = file?.hash?.vgroup ?? file?.vgroup ?? null;
  return h ? String(h) : null;
}

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(Number(n))) return '-';
  let v = Number(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Windowsで使えない文字を置き換え、ファイル名・フォルダ名として安全にする */
export function sanitizeName(name: string, fallback = '_'): string {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s.length > 150 ? s.slice(0, 150) : s;
}

/** 同じフォルダ内で名前がぶつかったら「名前 (2).拡張子」のように番号を付ける */
export function withNumber(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
