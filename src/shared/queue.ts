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
