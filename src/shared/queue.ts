/**
 * キューの1件の状態。
 * pending → copying → copied → deleting → downloading → done
 * 途中で失敗したら retry（共有から保存し直す）、何度も失敗したら error。
 */
export type ItemState =
  | 'pending'
  | 'copying'
  | 'copied'
  | 'deleting'
  | 'downloading'
  | 'done'
  | 'skipped'
  | 'retry'
  | 'error';

export const STATE_LABELS: Record<ItemState, string> = {
  pending: '待機中',
  copying: '保存中',
  copied: 'URL発行中',
  deleting: '削除中',
  downloading: 'ダウンロード中',
  done: '完了',
  skipped: '重複のため省略',
  retry: '再試行待ち',
  error: 'エラー',
};

export interface QueueItem {
  id: string;
  shareToken: string;
  shareName: string;
  /** 共有側のファイルID */
  sourceFileId: string;
  name: string;
  size: number | null;
  /** 基準フォルダからの相対フォルダ（共有名\共有内のフォルダ） */
  relDir: string;
  /** PCに保存するファイル名（名前がぶつかったら番号付き） */
  outName: string;
  hash: string | null;
  /** 重複していても落とし直す */
  force?: boolean;
  state: ItemState;
  attempts: number;
  /** 保存前にあった自分のファイルのID。自分が作ったコピーだけを消すために使う */
  beforeIds?: string[];
  copyStartedAt?: number;
  /** Linkex側の保存が終わった時刻（ここから一定時間コピーが見つからなければ保存し直す） */
  copiedAt?: number;
  /** 自分のストレージに作られたコピーのID */
  destFileId?: string;
  gid?: string;
  totalLength?: number;
  completedLength?: number;
  note?: string;
  error?: string;
  addedAt: number;
  updatedAt: number;
}

export interface EngineState {
  paused: boolean;
  /** 画面に出す今の状況 */
  message: string;
  updatedAt: number;
}

export interface EventEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const EVENTS_KEY = 'events';
export const MAX_EVENTS = 300;

export const QUEUE_KEY = 'queue';
export const ENGINE_KEY = 'engine';
export const HASHES_KEY = 'downloadedHashes';

export const ACTIVE_STATES: ItemState[] = ['copying', 'copied', 'deleting'];
export const FINISHED_STATES: ItemState[] = ['done', 'skipped'];

/** 画面で使う大まかな区分 */
export type QueueGroup = 'active' | 'waiting' | 'done' | 'skipped' | 'error';

export const GROUP_OF: Record<ItemState, QueueGroup> = {
  pending: 'waiting',
  retry: 'waiting',
  copying: 'active',
  copied: 'active',
  deleting: 'active',
  downloading: 'active',
  done: 'done',
  skipped: 'skipped',
  error: 'error',
};

export const GROUP_LABELS: Record<QueueGroup, string> = {
  active: '処理中',
  waiting: '待ち',
  done: '完了',
  skipped: '省略',
  error: '失敗',
};

export interface QueueSummary {
  total: number;
  counts: Record<QueueGroup, number>;
  /** 省略を除いた全体のバイト数 */
  bytesTotal: number;
  /** 落とし終わった分（ダウンロード中の途中まで含む） */
  bytesDone: number;
  /** これから落とす分（処理中・待ちの残り。失敗は含まない） */
  bytesRemaining: number;
}

/** キューを数え上げる。live にはMotrixから取った今の進み具合（gid → 取得済みバイト）を渡せる */
export function summarizeQueue(items: QueueItem[], live?: Map<string, number>): QueueSummary {
  const counts: Record<QueueGroup, number> = { active: 0, waiting: 0, done: 0, skipped: 0, error: 0 };
  let bytesTotal = 0;
  let bytesDone = 0;
  let bytesRemaining = 0;
  for (const item of items) {
    const group = GROUP_OF[item.state];
    counts[group]++;
    if (group === 'skipped') continue;
    const size = item.size ?? item.totalLength ?? 0;
    bytesTotal += size;
    let done = 0;
    if (item.state === 'done') done = size;
    else if (item.state === 'downloading') {
      done = (item.gid ? live?.get(item.gid) : undefined) ?? item.completedLength ?? 0;
    }
    bytesDone += done;
    if (group === 'active' || group === 'waiting') bytesRemaining += Math.max(0, size - done);
  }
  return { total: items.length, counts, bytesTotal, bytesDone, bytesRemaining };
}
