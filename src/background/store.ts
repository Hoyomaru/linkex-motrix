import {
  ENGINE_KEY,
  EVENTS_KEY,
  HASHES_KEY,
  MAX_EVENTS,
  QUEUE_KEY,
  type EngineState,
  type EventEntry,
  type QueueItem,
} from '../shared/queue';

// 処理ログ。新しいものを先頭に、最大 MAX_EVENTS 件まで残す
let eventLock: Promise<unknown> = Promise.resolve();
export function logEvent(level: EventEntry['level'], message: string): Promise<void> {
  const run = async () => {
    const stored = await chrome.storage.local.get(EVENTS_KEY);
    const events = (stored[EVENTS_KEY] as EventEntry[] | undefined) ?? [];
    events.unshift({ at: Date.now(), level, message });
    await chrome.storage.local.set({ [EVENTS_KEY]: events.slice(0, MAX_EVENTS) });
  };
  const next = eventLock.then(run, run);
  eventLock = next.catch(() => undefined);
  return next;
}

export async function clearEvents(): Promise<void> {
  await chrome.storage.local.set({ [EVENTS_KEY]: [] });
}

// キューの読み書きを1本にまとめ、同時に書き換えて内容が消えるのを防ぐ
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

export async function readQueue(): Promise<QueueItem[]> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
}

export function mutateQueue<T>(fn: (items: QueueItem[]) => T): Promise<T> {
  return exclusive(async () => {
    const items = await readQueue();
    const result = fn(items);
    await chrome.storage.local.set({ [QUEUE_KEY]: items });
    return result;
  });
}

export function updateItem(id: string, patch: Partial<QueueItem>): Promise<QueueItem | null> {
  return mutateQueue((items) => {
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: Date.now() });
    return { ...item };
  });
}

/** 複数の件をまとめて1回で書き換える（キュー全体の書き込みは重いため） */
export function updateItems(
  patches: Map<string, Partial<QueueItem>>,
  /** 書き換える直前の状態で確かめる条件（読んでから書くまでに別の操作で変わっていたら書かない） */
  when: (item: QueueItem) => boolean = () => true,
): Promise<void> {
  if (patches.size === 0) return Promise.resolve();
  return mutateQueue((items) => {
    const now = Date.now();
    for (const item of items) {
      const patch = patches.get(item.id);
      if (patch && when(item)) Object.assign(item, patch, { updatedAt: now });
    }
  });
}

export async function readEngine(): Promise<EngineState> {
  const stored = await chrome.storage.local.get(ENGINE_KEY);
  return (stored[ENGINE_KEY] as EngineState | undefined) ?? { paused: true, message: '停止中', updatedAt: Date.now() };
}

// 全体の状態の書き換えも1本にまとめる。
// 読んでから書くまでの間に別の書き換え（一時停止など）が入ると、古い値で上書きして消してしまうため
let engineLock: Promise<unknown> = Promise.resolve();
export function writeEngine(patch: Partial<EngineState>): Promise<EngineState> {
  const run = async () => {
    const current = await readEngine();
    // 中身が変わらないなら書かない（空き待ちの間は毎秒同じ表示を書こうとするため。
    // 書くたびにアイコンの件数を数え直す処理が走る）
    const same = Object.entries(patch).every(([k, v]) => current[k as keyof EngineState] === v);
    if (same) return current;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [ENGINE_KEY]: next });
    return next;
  };
  const next = engineLock.then(run, run);
  engineLock = next.catch(() => undefined);
  return next;
}

export async function readHashes(): Promise<Record<string, { name: string; at: number }>> {
  const stored = await chrome.storage.local.get(HASHES_KEY);
  return (stored[HASHES_KEY] as Record<string, { name: string; at: number }> | undefined) ?? {};
}

/** ダウンロード済みの記録（重複の省略に使う）を全部消す */
export async function clearHashes(): Promise<void> {
  await chrome.storage.local.remove(HASHES_KEY);
}

export async function rememberHash(hash: string, name: string): Promise<void> {
  const hashes = await readHashes();
  hashes[hash] = { name, at: Date.now() };
  await chrome.storage.local.set({ [HASHES_KEY]: hashes });
}
