import { formatBytes } from './files';

export { formatBytes };

export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '-';
}

/** 秒数を「1時間5分」「3分20秒」のように表す */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.round(seconds);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}時間${m % 60 ? `${m % 60}分` : ''}`;
  return `${Math.floor(h / 24)}日${h % 24 ? `${h % 24}時間` : ''}`;
}

/** 残りバイトと速度から残り時間を出す。速度がなければ '-' */
export function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec <= 0 || remainingBytes <= 0) return '-';
  return formatDuration(remainingBytes / bytesPerSec);
}

export function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
}
