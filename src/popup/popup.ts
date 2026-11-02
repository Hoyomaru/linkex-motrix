import { formatBytes, linkexApi } from '../shared/linkex-api';
import { send } from '../shared/messages';
import { ENGINE_KEY, QUEUE_KEY, type EngineState, type QueueItem } from '../shared/queue';

const $ = (id: string) => document.getElementById(id)!;
let paused = true;

$('open').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

$('toggle').addEventListener('click', async () => {
  await send({ type: paused ? 'queue.start' : 'queue.pause' });
});

function render(items: QueueItem[], engine: EngineState | undefined) {
  const count = (pred: (i: QueueItem) => boolean) => items.filter(pred).length;
  const done = count((i) => i.state === 'done' || i.state === 'skipped');
  const downloading = count((i) => i.state === 'downloading');
  const errors = count((i) => i.state === 'error');
  $('counts').textContent = items.length
    ? `${done}/${items.length}件 完了・DL中${downloading}${errors ? `・エラー${errors}` : ''}`
    : '空';
  paused = engine?.paused ?? true;
  $('toggle').textContent = paused ? '開始' : '一時停止';
  $('engine').textContent = engine ? engine.message : '';
}

async function refresh() {
  const stored = await chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY]);
  render((stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [], stored[ENGINE_KEY] as EngineState | undefined);
}
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void refresh();
});
void refresh();

(async () => {
  try {
    const [usage, traffic] = await Promise.all([linkexApi.usage(), linkexApi.traffic()]);
    $('usage').textContent = `${formatBytes(usage.usedSpace)} / ${formatBytes(usage.totalSpace)}`;
    ($('usage-bar') as HTMLElement).style.width = `${Math.min(100, (usage.usedSpace / usage.totalSpace) * 100)}%`;
    $('traffic').textContent = `${formatBytes(traffic.usedTraffic)} / ${formatBytes(traffic.totalTraffic)}`;
  } catch (e) {
    $('error').textContent = `Linkexの状態を取得できません: ${(e as Error).message}`;
  }
})();
