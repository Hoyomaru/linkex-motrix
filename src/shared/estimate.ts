import { formatBytes } from './files';
import type { QueueSummary } from './queue';
import { GROUP_OF, type QueueItem } from './queue';

export interface TrafficInfo {
  usedTraffic: number;
  totalTraffic: number;
  resetTime: number;
}

/** これから落とす量の見積もり */
export interface Estimate {
  /** これから落とすバイト数（処理中の残り＋待ち） */
  bytes: number;
  /** これから落とすファイル数 */
  files: number;
  /** サイズが分からないファイル数（見積もりに入っていない） */
  unknown: number;
  /** 転送量との比べ。上限なし・未取得なら null */
  traffic: {
    left: number;
    total: number;
    /** 今の転送量の残りで足りるか */
    fits: boolean;
    /** 足りないとき、上限ごとに止まりながら全部終わるまでのおおよその日数（24時間を1日とする） */
    days: number;
  } | null;
}

export function estimateRemaining(items: QueueItem[], summary: QueueSummary, traffic?: TrafficInfo | null): Estimate {
  let files = 0;
  let unknown = 0;
  for (const item of items) {
    const group = GROUP_OF[item.state];
    if (group !== 'active' && group !== 'waiting') continue;
    files++;
    if (item.size == null && !item.totalLength) unknown++;
  }
  const bytes = summary.bytesRemaining;
  let t: Estimate['traffic'] = null;
  // usedTraffic が負なら上限なしのアカウント
  if (traffic && traffic.totalTraffic > 0 && traffic.usedTraffic >= 0) {
    const left = Math.max(0, traffic.totalTraffic - traffic.usedTraffic);
    const fits = bytes <= left;
    const days = fits ? 0 : Math.ceil((bytes - left) / traffic.totalTraffic);
    t = { left, total: traffic.totalTraffic, fits, days };
  }
  return { bytes, files, unknown, traffic: t };
}

/** 見積もりの1行目（例: あと 12.34 GB・142件） */
export function estimateHeadline(e: Estimate): string {
  if (e.files === 0) return 'これから落とすファイルはありません';
  return `あと ${formatBytes(e.bytes)}・${e.files}件${e.unknown ? `（サイズ不明 ${e.unknown}件を除く）` : ''}`;
}

/** 転送量との比べを文にする。kind は色分け用 */
export function estimateTrafficLine(e: Estimate): { text: string; kind: 'ok' | 'warn' | 'muted' } {
  if (e.files === 0) return { text: '', kind: 'muted' };
  if (!e.traffic) return { text: '転送量の上限は確認できていません', kind: 'muted' };
  const { left, total, fits, days } = e.traffic;
  if (fits) return { text: `転送量の残り ${formatBytes(left)} で足ります`, kind: 'ok' };
  return {
    text: `転送量の残り ${formatBytes(left)} では足りません。上限（24時間で ${formatBytes(total)}）ごとに止まりながら、あと約${days}日`,
    kind: 'warn',
  };
}
