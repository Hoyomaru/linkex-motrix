import { ENGINE_KEY, QUEUE_KEY, summarizeQueue, type EngineState, type QueueItem } from '../shared/queue';

const GREEN = '#1f9d6b';
const RED = '#c93c3c';
const GREY = '#6b7480';

/**
 * ツールバーのアイコンに残り件数を出す。
 * 失敗があれば赤、止まっていれば灰色、動いていれば緑。
 */
export async function updateBadge(): Promise<void> {
  const stored = await chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY]);
  const items = (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
  const engine = stored[ENGINE_KEY] as EngineState | undefined;
  const s = summarizeQueue(items);
  const remaining = s.counts.active + s.counts.waiting;

  let text = '';
  if (remaining > 0) text = remaining > 999 ? '999+' : String(remaining);
  else if (s.counts.error > 0) text = '!';

  const color = s.counts.error > 0 ? RED : engine?.paused === false ? GREEN : GREY;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if ('setBadgeTextColor' in chrome.action) await chrome.action.setBadgeTextColor({ color: '#ffffff' });

  const parts = [`残り ${remaining}件`];
  if (s.counts.error) parts.push(`失敗 ${s.counts.error}件`);
  parts.push(engine?.paused === false ? '実行中' : '停止中');
  await chrome.action.setTitle({ title: `Linkex Motrix — ${parts.join('・')}` });
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** キューは頻繁に変わるので、まとめて更新する */
export function watchBadge(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[QUEUE_KEY] && !changes[ENGINE_KEY])) return;
    clearTimeout(timer);
    timer = setTimeout(() => void updateBadge().catch(() => undefined), 300);
  });
  void updateBadge().catch(() => undefined);
}
