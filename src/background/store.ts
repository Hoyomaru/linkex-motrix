import {
  ENGINE_KEY,
  HASHES_KEY,
  QUEUE_KEY,
  type EngineState,
  type QueueItem,
} from '../shared/queue';

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

export async function readEngine(): Promise<EngineState> {
  const stored = await chrome.storage.local.get(ENGINE_KEY);
  return (stored[ENGINE_KEY] as EngineState | undefined) ?? { paused: true, message: '停止中', updatedAt: Date.now() };
}

export async function writeEngine(patch: Partial<EngineState>): Promise<EngineState> {
  const next = { ...(await readEngine()), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [ENGINE_KEY]: next });
  return next;
}

export async function readHashes(): Promise<Record<string, { name: string; at: number }>> {
  const stored = await chrome.storage.local.get(HASHES_KEY);
  return (stored[HASHES_KEY] as Record<string, { name: string; at: number }> | undefined) ?? {};
}

export async function rememberHash(hash: string, name: string): Promise<void> {
  const hashes = await readHashes();
  hashes[hash] = { name, at: Date.now() };
  await chrome.storage.local.set({ [HASHES_KEY]: hashes });
}
