import { formatBytes } from '../shared/files';
import { send } from '../shared/messages';
import {
  ENGINE_KEY,
  QUEUE_KEY,
  STATE_LABELS,
  type EngineState,
  type ItemState,
  type QueueItem,
} from '../shared/queue';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupQueueView(log: (label: string, value?: unknown) => void) {
  const run = (button: HTMLButtonElement, fn: () => Promise<void>) =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await fn();
      } catch (e) {
        log(`エラー: ${(e as Error).message}`);
      } finally {
        button.disabled = false;
      }
    });

  run($('queue-add'), async () => {
    const input = $<HTMLTextAreaElement>('queue-input');
    const button = $<HTMLButtonElement>('queue-add');
    button.textContent = '読み込み中…';
    const res = await send<{
      added: number;
      alreadyQueued: number;
      invalid: string[];
      failed: { token: string; error: string }[];
      elapsedMs: number;
    }>({ type: 'queue.add', text: input.value }).finally(() => (button.textContent = 'キューに追加'));
    if (!res.ok) throw new Error(res.error);
    const r = res.data;
    log(
      `キューに追加: ${r.added}件（すでにあった ${r.alreadyQueued}件・${(r.elapsedMs / 1000).toFixed(1)}秒）`,
      r.invalid.length || r.failed.length ? { 読めなかったURL: r.invalid, 失敗した共有: r.failed } : undefined,
    );
    if (r.failed.length === 0 && r.invalid.length === 0) input.value = '';
  });
  run($('queue-start'), async () => {
    const res = await send({ type: 'queue.start' });
    if (!res.ok) throw new Error(res.error);
  });
  run($('queue-pause'), async () => {
    const res = await send({ type: 'queue.pause' });
    if (!res.ok) throw new Error(res.error);
  });
  run($('queue-clear'), async () => {
    const res = await send({ type: 'queue.clearFinished' });
    if (!res.ok) throw new Error(res.error);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[QUEUE_KEY]) renderQueue((changes[QUEUE_KEY].newValue as QueueItem[] | undefined) ?? []);
    if (changes[ENGINE_KEY]) renderEngine(changes[ENGINE_KEY].newValue as EngineState | undefined);
  });
  chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY]).then((stored) => {
    renderQueue((stored[QUEUE_KEY] as QueueItem[] | undefined) ?? []);
    renderEngine(stored[ENGINE_KEY] as EngineState | undefined);
  });

  function renderEngine(engine: EngineState | undefined) {
    const el = $('engine-message');
    if (!engine) {
      el.textContent = '停止中';
      return;
    }
    el.textContent = `${engine.paused ? '■ 停止中' : '▶ 実行中'}　${engine.message}`;
  }

  function renderQueue(items: QueueItem[]) {
    const counts = new Map<ItemState, number>();
    for (const i of items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
    $('queue-counts').textContent = items.length
      ? `全${items.length}件　` +
        [...counts.entries()].map(([s, n]) => `${STATE_LABELS[s]} ${n}`).join(' / ')
      : 'キューは空です';

    const table = $<HTMLTableElement>('queue-table');
    table.hidden = items.length === 0;
    const rows = items.map((item) => {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = item.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${item.relDir}\\${item.outName}`;
      tdName.append(sub);
      if (item.error && item.state !== 'done') {
        const err = document.createElement('div');
        err.className = 'err';
        err.textContent = item.error;
        tdName.append(err);
      }

      const tdSize = document.createElement('td');
      tdSize.textContent = formatBytes(item.size);

      const tdState = document.createElement('td');
      tdState.className = `state state-${item.state}`;
      let text = STATE_LABELS[item.state];
      if (item.state === 'downloading' && item.totalLength) {
        text += ` ${Math.floor(((item.completedLength ?? 0) / item.totalLength) * 100)}%`;
      }
      if (item.note) text += `（${item.note}）`;
      tdState.textContent = text;

      const tdActions = document.createElement('td');
      tdActions.className = 'actions';
      if (item.state === 'error' || item.state === 'skipped') {
        const b = document.createElement('button');
        b.textContent = item.state === 'skipped' ? '落とし直す' : '再試行';
        run(b, async () => {
          await send({ type: 'queue.retry', id: item.id });
        });
        tdActions.append(b);
      }
      if (!['copying', 'copied', 'deleting'].includes(item.state)) {
        const b = document.createElement('button');
        b.textContent = '削除';
        run(b, async () => {
          await send({ type: 'queue.remove', id: item.id });
        });
        tdActions.append(b);
      }

      tr.append(tdName, tdSize, tdState, tdActions);
      return tr;
    });
    table.tBodies[0].replaceChildren(...rows);
  }
}
