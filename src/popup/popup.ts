import { formatBytes, formatEta, formatSpeed, percent } from '../shared/format';
import { linkexApi } from '../shared/linkex-api';
import { send } from '../shared/messages';
import { ENGINE_KEY, QUEUE_KEY, STATE_LABELS, summarizeQueue, type EngineState, type QueueItem } from '../shared/queue';
import { pollMotrix, toProgressMap, type LiveProgress } from '../ui/live';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let items: QueueItem[] = [];
let engine: EngineState | undefined;
let progress = new Map<string, LiveProgress>();

async function openDashboard(tab?: string) {
  await send({ type: 'dashboard.open', tab });
  window.close();
}
$('open').addEventListener('click', () => void openDashboard());
$('error-link').addEventListener('click', (ev) => {
  ev.preventDefault();
  void openDashboard('queue');
});

$('toggle').addEventListener('click', async () => {
  await send({ type: engine?.paused === false ? 'queue.pause' : 'queue.start' });
});

// ---------- 追加 ----------
const addButton = $<HTMLButtonElement>('add');
addButton.addEventListener('click', async () => {
  const input = $<HTMLTextAreaElement>('input');
  const result = $('result');
  if (!input.value.trim()) {
    input.focus();
    return;
  }
  addButton.disabled = true;
  addButton.textContent = '読み込み中…';
  result.className = 'result muted';
  result.textContent = '共有の中身を読み込んでいます…';
  try {
    const res = await send<{ added: number; alreadyQueued: number; invalid: string[]; failed: { token: string; error: string }[] }>({
      type: 'queue.add',
      text: input.value,
    });
    if (!res.ok) throw new Error(res.error);
    const r = res.data;
    const parts = [`${r.added}件を追加`];
    if (r.alreadyQueued) parts.push(`すでにあった ${r.alreadyQueued}件`);
    if (r.invalid.length) parts.push(`読めなかったURL ${r.invalid.length}件`);
    if (r.failed.length) parts.push(`開けなかった共有 ${r.failed.length}件`);
    if (r.added > 0 && $<HTMLInputElement>('autostart').checked && engine?.paused !== false) {
      const started = await send({ type: 'queue.start' });
      parts.push(started.ok ? '開始しました' : `開始できませんでした: ${started.error}`);
    }
    const problem = r.invalid.length > 0 || r.failed.length > 0;
    result.className = `result ${problem ? 'ng' : 'ok'}`;
    result.textContent = parts.join('・');
    input.value = problem ? [...r.invalid, ...r.failed.map((f) => f.token)].join('\n') : '';
  } catch (e) {
    result.className = 'result ng';
    result.textContent = (e as Error).message;
  } finally {
    addButton.disabled = false;
    addButton.textContent = 'キューに追加';
  }
});
$('input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) addButton.click();
});

// ---------- 表示 ----------
function render() {
  const paused = engine?.paused ?? true;
  const message = engine?.message ?? '';
  const waiting = !paused && /待機|待ち|空き/.test(message);
  $('pill').textContent = paused ? '停止中' : waiting ? '待機中' : '実行中';
  $('pill').className = `pill ${paused ? '' : waiting ? 'waiting' : 'running'}`;
  $('engine').textContent = message;
  $('engine').title = message;
  $('toggle').textContent = paused ? '開始' : '一時停止';
  $('toggle').className = paused ? 'primary' : '';

  const completed = new Map<string, number>();
  for (const [gid, p] of progress) completed.set(gid, p.completed);
  const s = summarizeQueue(items, completed);
  if (s.total === 0) {
    $('count').textContent = 'キューは空です';
    $('bytes').textContent = '';
  } else {
    $('count').textContent = `${s.counts.done} / ${s.total - s.counts.skipped}件 完了`;
    $('bytes').textContent = `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`;
  }
  $('bar').style.width = `${percent(s.bytesDone, s.bytesTotal)}%`;

  let speed = 0;
  for (const item of items) if (item.gid) speed += progress.get(item.gid)?.speed ?? 0;
  $('speed').textContent = speed > 0 ? formatSpeed(speed) : '';
  $('eta').textContent = s.bytesRemaining > 0 && speed > 0
    ? `残り ${formatBytes(s.bytesRemaining)}・あと約 ${formatEta(s.bytesRemaining, speed)}`
    : '';

  // 今動いているファイル（最大4件）
  const active = items.filter((i) => ['copying', 'copied', 'deleting', 'downloading'].includes(i.state)).slice(0, 4);
  const list = $('current');
  list.hidden = active.length === 0;
  list.replaceChildren(
    ...active.map((item) => {
      const li = document.createElement('li');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;
      name.title = item.name;
      const live = document.createElement('div');
      live.className = 'live';
      li.append(name);
      const p = item.gid ? progress.get(item.gid) : undefined;
      if (item.state === 'downloading') {
        const meter = document.createElement('div');
        meter.className = 'meter info';
        const bar = document.createElement('div');
        const done = p?.completed ?? item.completedLength ?? 0;
        const total = p?.total || item.totalLength || item.size || 0;
        bar.style.width = `${percent(done, total)}%`;
        meter.append(bar);
        li.append(meter);
        live.textContent = p
          ? `${percent(done, total).toFixed(1)}%・${formatSpeed(p.speed)}・残り ${formatEta(total - done, p.speed)}`
          : STATE_LABELS[item.state];
      } else {
        live.textContent = STATE_LABELS[item.state];
      }
      li.append(live);
      return li;
    }),
  );

  $('error-line').hidden = s.counts.error === 0;
  $('error-link').textContent = `失敗 ${s.counts.error}件 — 専用ページで確認`;
}

async function load() {
  const stored = await chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY]);
  items = (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
  engine = stored[ENGINE_KEY] as EngineState | undefined;
  render();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[QUEUE_KEY]) items = (changes[QUEUE_KEY].newValue as QueueItem[] | undefined) ?? [];
  if (changes[ENGINE_KEY]) engine = changes[ENGINE_KEY].newValue as EngineState | undefined;
  if (changes[QUEUE_KEY] || changes[ENGINE_KEY]) render();
});
void load();

pollMotrix((live, error) => {
  progress = toProgressMap(live);
  $('motrix-dot').className = `dot ${live ? 'ok' : 'ng'}`;
  $('motrix-text').textContent = live ? 'Motrix 接続中' : 'Motrix に接続できません';
  $('motrix').title = error ?? '';
  render();
});

function setMeter(barId: string, used: number, total: number) {
  const ratio = total > 0 ? used / total : 0;
  const bar = $(barId);
  bar.style.width = `${Math.min(100, ratio * 100)}%`;
  bar.parentElement!.className = `meter${ratio >= 1 ? ' ng' : ratio >= 0.8 ? ' warn' : ''}`;
}

(async () => {
  try {
    const [usage, traffic] = await Promise.all([linkexApi.usage(), linkexApi.traffic()]);
    $('usage').textContent = `${formatBytes(usage.usedSpace)} / ${formatBytes(usage.totalSpace)}`;
    setMeter('usage-bar', usage.usedSpace, usage.totalSpace);
    $('traffic').textContent = `${formatBytes(traffic.usedTraffic)} / ${formatBytes(traffic.totalTraffic)}`;
    setMeter('traffic-bar', traffic.usedTraffic, traffic.totalTraffic);
  } catch (e) {
    $('usage').textContent = '取得できません';
    $('usage').title = (e as Error).message;
  }
})();
