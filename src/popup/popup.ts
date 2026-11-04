import { formatBytes, formatEta, formatSpeed, percent } from '../shared/format';
import { estimateHeadline, estimateRemaining, estimateTrafficLine, type TrafficInfo } from '../shared/estimate';
import { linkexApi } from '../shared/linkex-api';
import { send } from '../shared/messages';
import { extractShareUrls, parseShareToken } from '../shared/share-url';
import { ENGINE_KEY, QUEUE_KEY, STATE_LABELS, summarizeQueue, type EngineState, type QueueItem } from '../shared/queue';
import { engineView, pollMotrix, toProgressMap, type LiveProgress } from '../ui/live';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let items: QueueItem[] = [];
let engine: EngineState | undefined;
let progress = new Map<string, LiveProgress>();
let traffic: TrafficInfo | null = null;

async function openDashboard(tab?: string) {
  await send({ type: 'dashboard.open', tab });
  window.close();
}
$('open').addEventListener('click', () => void openDashboard());
$('counts').addEventListener('click', (ev) => {
  if (!(ev.target as HTMLElement).closest('a')) return;
  ev.preventDefault();
  void openDashboard('queue');
});

$('toggle').addEventListener('click', async () => {
  await send({ type: engine?.paused === false ? 'queue.pause' : 'queue.start' });
});

// ---------- 追加 ----------
const result = $('result');
function showResult(text: string, kind: '' | 'ok' | 'ng' | 'muted') {
  result.className = `result ${kind}`;
  result.textContent = text;
}

/** URL（複数可）をキューに追加し、必要なら開始する。うまく読めなかったURLを返す */
async function addUrls(text: string, button: HTMLButtonElement, label: string): Promise<string[]> {
  button.disabled = true;
  button.textContent = '読み込み中…';
  showResult('共有の中身を読み込んでいます…', 'muted');
  try {
    const res = await send<{ added: number; addedBytes: number; alreadyQueued: number; invalid: string[]; failed: { token: string; error: string }[] }>({
      type: 'queue.add',
      text,
    });
    if (!res.ok) throw new Error(res.error);
    const r = res.data;
    const parts = [r.added ? `${r.added}件（${formatBytes(r.addedBytes)}）を追加` : '追加はありません'];
    if (r.alreadyQueued) parts.push(`すでにあった ${r.alreadyQueued}件`);
    if (r.invalid.length) parts.push(`読めなかったURL ${r.invalid.length}件`);
    if (r.failed.length) parts.push(`開けなかった共有 ${r.failed.length}件`);
    if (r.added > 0 && $<HTMLInputElement>('autostart').checked && engine?.paused !== false) {
      const started = await send({ type: 'queue.start' });
      parts.push(started.ok ? '開始しました' : `開始できませんでした: ${started.error}`);
    }
    const problem = r.invalid.length > 0 || r.failed.length > 0;
    showResult(parts.join('・'), problem ? 'ng' : 'ok');
    return [...r.invalid, ...r.failed.map((f) => f.token)];
  } catch (e) {
    showResult((e as Error).message, 'ng');
    return text.split(/\s+/).filter(Boolean);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const addButton = $<HTMLButtonElement>('add');
addButton.addEventListener('click', async () => {
  const input = $<HTMLTextAreaElement>('input');
  if (!input.value.trim()) {
    input.focus();
    return;
  }
  const left = await addUrls(input.value, addButton, 'キューに追加');
  input.value = left.join('\n');
});
$('input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) addButton.click();
});

// ---------- このページのリンクを集める ----------
interface FoundLink {
  url: string;
  text: string;
}

/** 開いているページの中で動く。リンクと本文から共有URLらしいものを拾う（外の変数は使えない） */
function collectLinksInPage(): FoundLink[] {
  const pattern = /(?:https?:\/\/)?(?:www\.)?(?:linkex\.io|l2e\.click)\/(?:f|d|s)\/[A-Za-z0-9_-]{4,64}/gi;
  const found: FoundLink[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = (a as HTMLAnchorElement).href;
    for (const m of href.match(pattern) ?? []) {
      found.push({ url: m, text: (a.textContent ?? '').trim().slice(0, 120) });
    }
  }
  for (const m of (document.body?.innerText ?? '').match(pattern) ?? []) found.push({ url: m, text: '' });
  return found;
}

const collectBox = $('collected');
const collectList = $('collect-list');
const collectAll = $<HTMLInputElement>('collect-all');
const collectAdd = $<HTMLButtonElement>('collect-add');

const collectBoxes = () => Array.from(collectList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
function updateCollectCount() {
  const usable = collectBoxes().filter((b) => !b.disabled);
  const checked = usable.filter((b) => b.checked);
  $('collect-count').textContent = `${checked.length} / ${usable.length}件`;
  collectAll.checked = usable.length > 0 && checked.length === usable.length;
  collectAdd.disabled = checked.length === 0;
}

const collectButton = $<HTMLButtonElement>('collect');
collectButton.addEventListener('click', async () => {
  collectButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('今のタブが分かりませんでした');
    let found: FoundLink[];
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectLinksInPage });
      found = (injection?.result as FoundLink[] | undefined) ?? [];
    } catch {
      throw new Error('このページは読み取れません（ブラウザの設定画面などは対象外です）');
    }

    // 同じ共有は1つにまとめ、リンクの文字があればそれを残す
    const byToken = new Map<string, FoundLink>();
    for (const f of found) {
      const [url] = extractShareUrls(f.url);
      const token = url ? parseShareToken(url) : null;
      if (!token) continue;
      const prev = byToken.get(token);
      if (!prev) byToken.set(token, { url, text: f.text });
      else if (!prev.text && f.text) prev.text = f.text;
    }
    if (byToken.size === 0) {
      collectBox.hidden = true;
      showResult('このページにLinkexの共有リンクは見つかりませんでした', 'muted');
      return;
    }

    const queuedTokens = new Set(items.map((i) => i.shareToken));
    collectList.replaceChildren(
      ...[...byToken].map(([token, link]) => {
        const li = document.createElement('li');
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = link.url;
        const queued = queuedTokens.has(token);
        box.checked = !queued;
        box.disabled = queued;
        box.addEventListener('change', updateCollectCount);
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = link.text && link.text !== link.url ? link.text : link.url;
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = queued ? `${token}・キューにあり` : link.url;
        text.append(sub);
        label.append(box, text);
        li.append(label);
        if (queued) li.className = 'queued';
        return li;
      }),
    );
    collectBox.hidden = false;
    updateCollectCount();
    showResult(`${byToken.size}件の共有リンクが見つかりました`, 'muted');
  } catch (e) {
    showResult((e as Error).message, 'ng');
  } finally {
    collectButton.disabled = false;
  }
});

collectAll.addEventListener('change', () => {
  for (const b of collectBoxes()) if (!b.disabled) b.checked = collectAll.checked;
  updateCollectCount();
});
$('collect-cancel').addEventListener('click', () => {
  collectBox.hidden = true;
  showResult('', '');
});
collectAdd.addEventListener('click', async () => {
  const urls = collectBoxes().filter((b) => b.checked && !b.disabled).map((b) => b.value);
  if (urls.length === 0) return;
  const left = await addUrls(urls.join('\n'), collectAdd, '選んだリンクを追加');
  if (left.length === 0) collectBox.hidden = true;
  else $<HTMLTextAreaElement>('input').value = left.join('\n');
});

// ---------- 表示 ----------
function render() {
  const view = engineView(engine, items);
  $('pill').textContent = view.pill;
  $('pill').className = `pill ${view.tone}`;
  $('engine').textContent = view.message;
  $('engine').title = view.message;
  $('toggle').textContent = view.paused ? '開始' : '一時停止';
  $('toggle').dataset.icon = view.paused ? 'play' : 'pause';
  $('toggle').className = view.paused ? 'primary' : '';

  const completed = new Map<string, number>();
  for (const [gid, p] of progress) completed.set(gid, p.completed);
  const s = summarizeQueue(items, completed);
  const empty = s.total === 0;
  const pct = percent(s.bytesDone, s.bytesTotal);
  $('hero').classList.toggle('empty', empty);
  $('tiles').hidden = empty;
  $('counts').hidden = empty;
  if (empty) {
    $('percent').textContent = 'キューは空です';
    $('count').textContent = '';
    $('bytes').textContent = '';
  } else {
    $('percent').innerHTML = `${Math.floor(pct)}<small>%</small>`;
    $('count').textContent = `${s.counts.done} / ${s.total - s.counts.skipped}件 完了`;
    $('bytes').textContent = `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`;
  }
  $('bar').style.width = `${pct}%`;
  $('bar-wrap').setAttribute('aria-valuenow', String(Math.floor(pct)));

  let speed = 0;
  for (const item of items) if (item.gid) speed += progress.get(item.gid)?.speed ?? 0;
  $('speed').textContent = speed > 0 ? formatSpeed(speed) : '-';
  $('left').textContent = s.bytesRemaining > 0 ? formatBytes(s.bytesRemaining) : '-';
  $('eta').textContent = s.bytesRemaining > 0 && speed > 0 ? formatEta(s.bytesRemaining, speed) : '-';

  const chip = (cls: string, label: string, n: number, link = false) => {
    const e = document.createElement(link ? 'a' : 'span');
    e.className = cls;
    if (link) {
      (e as HTMLAnchorElement).href = '#';
      e.title = '専用ページで確認';
    }
    e.append(`${label} `);
    const b = document.createElement('b');
    b.textContent = String(n);
    e.append(b);
    return e;
  };
  const chips = [
    s.counts.active ? chip('c-active', '処理中', s.counts.active) : null,
    s.counts.waiting ? chip('c-waiting', '待ち', s.counts.waiting) : null,
    chip('c-done', '完了', s.counts.done),
    s.counts.skipped ? chip('c-skipped', '省略', s.counts.skipped) : null,
    s.counts.error ? chip('c-error', '失敗', s.counts.error, true) : null,
  ].filter((c): c is HTMLElement => c !== null);
  $('counts').replaceChildren(...chips);

  // 見積もり
  const est = estimateRemaining(items, s, traffic);
  const estBox = $('estimate');
  estBox.hidden = est.files === 0;
  const line = estimateTrafficLine(est);
  estBox.className = `estimate ${line.kind === 'muted' ? '' : line.kind}`;
  $('est-headline').textContent = estimateHeadline(est);
  $('est-traffic').textContent = line.text;

  // 今動いているファイル（ポップアップの高さに収めるため最大2件。全体の件数は「処理中」に出る）
  const allActive = items.filter((i) => ['copying', 'copied', 'deleting', 'downloading'].includes(i.state));
  const active = allActive.slice(0, 2);
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
}

async function load() {
  const stored = await chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY]);
  items = (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
  engine = stored[ENGINE_KEY] as EngineState | undefined;
  // キューが空なら、最初にすることは追加なので開いておく
  if (items.length === 0) $<HTMLDetailsElement>('add-box').open = true;
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
    const [usage, t] = await Promise.all([linkexApi.usage(), linkexApi.traffic()]);
    traffic = t;
    render();
    $('usage').textContent = `${formatBytes(usage.usedSpace)} / ${formatBytes(usage.totalSpace)}`;
    setMeter('usage-bar', usage.usedSpace, usage.totalSpace);
    $('traffic').textContent = `${formatBytes(t.usedTraffic)} / ${formatBytes(t.totalTraffic)}`;
    setMeter('traffic-bar', t.usedTraffic, t.totalTraffic);
  } catch (e) {
    $('usage').textContent = '取得できません';
    $('usage').title = (e as Error).message;
  }
})();
