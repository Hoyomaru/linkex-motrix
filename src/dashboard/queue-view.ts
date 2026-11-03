import { formatBytes, formatEta, formatSpeed, percent } from '../shared/format';
import { send, type MotrixLive } from '../shared/messages';
import {
  ACTIVE_STATES,
  ENGINE_KEY,
  EVENTS_KEY,
  GROUP_LABELS,
  GROUP_OF,
  QUEUE_KEY,
  STATE_LABELS,
  summarizeQueue,
  type EngineState,
  type EventEntry,
  type QueueGroup,
  type QueueItem,
} from '../shared/queue';
import { estimateHeadline, estimateRemaining, estimateTrafficLine, type TrafficInfo } from '../shared/estimate';
import { pollMotrix, toProgressMap, type LiveProgress } from '../ui/live';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Filter = 'all' | QueueGroup;
const FILTERS: Filter[] = ['all', 'active', 'waiting', 'error', 'done', 'skipped'];
/** 一覧の中での並び順。動いているもの・失敗を上に出す */
const ORDER: Record<QueueGroup, number> = { active: 0, error: 1, waiting: 2, done: 3, skipped: 4 };
/** 1つの共有の中で、最初に表示する件数（多すぎると重くなるため） */
const PAGE_SIZE = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export function setupQueueView(log: (label: string, value?: unknown) => void) {
  let items: QueueItem[] = [];
  let engine: EngineState | undefined;
  let events: EventEntry[] = [];
  let progress = new Map<string, LiveProgress>();
  let traffic: TrafficInfo | null = null;
  let filter: Filter = 'all';
  let search = '';
  let eventLevel: 'all' | 'problem' = 'all';
  /** 共有ごとの開閉（ユーザーが触ったものだけ覚える） */
  const openState = new Map<string, boolean>();
  /** 共有ごとの表示件数 */
  const limits = new Map<string, number>();
  /** ダウンロード中の行。速度などをその場で書き換えるために持っておく */
  let liveRows = new Map<string, { bar: HTMLDivElement; text: HTMLDivElement }>();

  /** ボタンを押している間は無効にして、例外は画面とログに出す */
  const run = (button: HTMLButtonElement, fn: () => Promise<void>, opts: { inSummary?: boolean } = {}) =>
    button.addEventListener('click', async (ev) => {
      if (opts.inSummary) {
        // 見出しの中のボタンで開閉しないようにする
        ev.preventDefault();
        ev.stopPropagation();
      }
      button.disabled = true;
      try {
        await fn();
      } catch (e) {
        log(`エラー: ${(e as Error).message}`);
        alert((e as Error).message);
      } finally {
        button.disabled = false;
      }
    });

  const must = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const res = await p;
    if (!res.ok) throw new Error(res.error);
  };

  // ---------- 追加 ----------
  const addButton = $<HTMLButtonElement>('queue-add');
  const addResult = $('add-result');
  const showAddResult = (text: string, kind: '' | 'ok' | 'ng') => {
    addResult.textContent = text;
    addResult.className = `add-result ${kind}`;
  };
  addButton.addEventListener('click', async () => {
    const input = $<HTMLTextAreaElement>('queue-input');
    if (!input.value.trim()) {
      showAddResult('共有URLを貼り付けてください', 'ng');
      input.focus();
      return;
    }
    addButton.disabled = true;
    addButton.textContent = '読み込み中…';
    showAddResult('共有の中身を読み込んでいます…', '');
    try {
      const res = await send<{
        added: number;
        addedBytes: number;
        alreadyQueued: number;
        invalid: string[];
        failed: { token: string; error: string }[];
        elapsedMs: number;
      }>({ type: 'queue.add', text: input.value });
      if (!res.ok) throw new Error(res.error);
      const r = res.data;
      const parts = [r.added ? `${r.added}件（${formatBytes(r.addedBytes)}）を追加しました` : '追加はありません'];
      if (r.alreadyQueued) parts.push(`すでにあった ${r.alreadyQueued}件`);
      if (r.invalid.length) parts.push(`読めなかったURL ${r.invalid.length}件`);
      if (r.failed.length) parts.push(`開けなかった共有 ${r.failed.length}件（${r.failed[0].error}）`);
      if (r.added > 0 && $<HTMLInputElement>('add-autostart').checked && engine?.paused !== false) {
        const started = await send({ type: 'queue.start' });
        parts.push(started.ok ? '処理を開始しました' : `開始できませんでした: ${started.error}`);
      }
      const problem = r.invalid.length > 0 || r.failed.length > 0;
      showAddResult(parts.join('・'), problem ? 'ng' : 'ok');
      log(`キューに追加（${(r.elapsedMs / 1000).toFixed(1)}秒）`, r);
      if (!problem) {
        input.value = '';
      } else {
        // 失敗したURLだけを欄に残して、もう一度押せるようにする
        input.value = [...r.invalid, ...r.failed.map((f) => f.token)].join('\n');
      }
    } catch (e) {
      showAddResult((e as Error).message, 'ng');
    } finally {
      addButton.disabled = false;
      addButton.textContent = 'キューに追加';
    }
  });
  $('queue-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) addButton.click();
  });

  // ---------- 開始・一時停止 ----------
  const toggle = $<HTMLButtonElement>('engine-toggle');
  run(toggle, () => must(send({ type: engine?.paused === false ? 'queue.pause' : 'queue.start' })));

  // ---------- 絞り込み ----------
  $('queue-search').addEventListener('input', (ev) => {
    search = (ev.target as HTMLInputElement).value.trim().toLowerCase();
    scheduleRender(0);
  });
  run($('retry-failed'), () => must(send({ type: 'queue.retryFailed' })));
  run($('queue-clear'), () => must(send({ type: 'queue.clearFinished' })));

  // ---------- 処理ログ ----------
  run($('events-clear'), () => must(send({ type: 'events.clear' })));
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#event-filters .chip')) {
    chip.addEventListener('click', () => {
      eventLevel = chip.dataset.level as 'all' | 'problem';
      document.querySelectorAll('#event-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderEvents();
    });
  }

  // ---------- データの受け取り ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[QUEUE_KEY]) {
      items = (changes[QUEUE_KEY].newValue as QueueItem[] | undefined) ?? [];
      scheduleRender();
    }
    if (changes[ENGINE_KEY]) {
      engine = changes[ENGINE_KEY].newValue as EngineState | undefined;
      renderEngine();
    }
    if (changes[EVENTS_KEY]) {
      events = (changes[EVENTS_KEY].newValue as EventEntry[] | undefined) ?? [];
      renderEvents();
    }
  });
  chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY, EVENTS_KEY]).then((stored) => {
    items = (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
    engine = stored[ENGINE_KEY] as EngineState | undefined;
    events = (stored[EVENTS_KEY] as EventEntry[] | undefined) ?? [];
    render();
    renderEngine();
    renderEvents();
  });

  pollMotrix((live, error) => {
    renderMotrix(live, error);
    progress = toProgressMap(live);
    updateLive();
    renderOverview();
  });

  // ---------- 描画 ----------
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  /** 何度も続けて変わるので、まとめて描き直す */
  function scheduleRender(delay = 200) {
    if (renderTimer !== undefined) {
      if (delay > 0) return;
      clearTimeout(renderTimer);
    }
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, delay);
  }

  function renderMotrix(live: MotrixLive | null, error?: string) {
    const dot = $('m-motrix-dot');
    if (live) {
      dot.className = 'dot ok';
      $('m-motrix').textContent = live.active.length ? `接続中・${live.active.length}件実行中` : '接続中';
      $('m-motrix').title = '';
      $('m-speed').textContent = formatSpeed(live.downloadSpeed);
    } else {
      dot.className = 'dot ng';
      $('m-motrix').textContent = '接続できません';
      $('m-motrix').title = error ?? '';
      $('m-speed').textContent = '-';
    }
  }

  function renderEngine() {
    const pill = $('engine-pill');
    const paused = engine?.paused ?? true;
    const message = engine?.message ?? '';
    const waiting = !paused && /待機|待ち|空き/.test(message);
    pill.textContent = paused ? '停止中' : waiting ? '待機中' : '実行中';
    pill.className = `pill ${paused ? '' : waiting ? 'waiting' : 'running'}`;
    $('engine-message').textContent = message;
    $('engine-message').title = message;
    toggle.textContent = paused ? '開始' : '一時停止';
    toggle.className = paused ? 'primary toggle' : 'toggle pause';
    toggle.dataset.icon = paused ? 'play' : 'pause';
  }

  function ourSpeed(): number {
    let speed = 0;
    for (const item of items) if (item.gid) speed += progress.get(item.gid)?.speed ?? 0;
    return speed;
  }

  function renderOverview() {
    const completed = new Map<string, number>();
    for (const [gid, p] of progress) completed.set(gid, p.completed);
    const s = summarizeQueue(items, completed);

    const empty = s.total === 0;
    $('ov-tiles').hidden = empty;
    if (empty) {
      $('ov-percent').textContent = '-';
      $('ov-count').textContent = 'キューは空です';
      $('ov-bytes').textContent = '';
      $('ov-bar').style.width = '0';
    } else {
      const target = s.total - s.counts.skipped;
      const extra = [
        s.counts.skipped ? `省略 ${s.counts.skipped}` : '',
        s.counts.error ? `失敗 ${s.counts.error}` : '',
      ].filter(Boolean);
      const pct = percent(s.bytesDone, s.bytesTotal);
      $('ov-percent').innerHTML = `${Math.floor(pct)}<small>%</small>`;
      $('ov-count').textContent = `${s.counts.done} / ${target}件 完了${extra.length ? `（${extra.join('・')}）` : ''}`;
      $('ov-bytes').textContent = `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`;
      $('ov-bar').style.width = `${pct}%`;
      const speed = ourSpeed();
      const downloading = items.filter((i) => i.state === 'downloading').length;
      $('ov-speed').textContent = downloading ? `${downloading}件・${formatSpeed(speed)}` : '-';
      $('ov-left').textContent = s.bytesRemaining > 0 ? formatBytes(s.bytesRemaining) : '-';
      $('ov-eta').textContent = s.bytesRemaining > 0 && speed > 0 ? formatEta(s.bytesRemaining, speed) : '-';
    }

    const est = estimateRemaining(items, s, traffic);
    const estBox = $('ov-estimate');
    estBox.hidden = est.files === 0;
    const line = estimateTrafficLine(est);
    estBox.className = `estimate ${line.kind === 'muted' ? '' : line.kind}`;
    $('ov-est-headline').textContent = estimateHeadline(est);
    $('ov-est-traffic').textContent = line.text;

    const badge = $('tab-badge-error');
    badge.hidden = s.counts.error === 0;
    badge.textContent = String(s.counts.error);
    const retry = $<HTMLButtonElement>('retry-failed');
    retry.hidden = s.counts.error === 0;
    retry.textContent = `失敗 ${s.counts.error}件をすべて再試行`;
    return s;
  }

  function renderFilters(counts: Record<QueueGroup, number>, total: number) {
    const box = $('filters');
    box.replaceChildren(
      ...FILTERS.map((f) => {
        const n = f === 'all' ? total : counts[f];
        const chip = el('button', `chip${filter === f ? ' active' : ''}`, f === 'all' ? 'すべて' : GROUP_LABELS[f]);
        chip.append(el('span', 'n', String(n)));
        chip.addEventListener('click', () => {
          filter = f;
          scheduleRender(0);
        });
        return chip;
      }),
    );
  }

  function render() {
    const s = renderOverview();
    renderFilters(s.counts, s.total);

    // 共有ごとにまとめる（キューに入った順）
    const groups = new Map<string, QueueItem[]>();
    for (const item of items) {
      const list = groups.get(item.shareToken);
      if (list) list.push(item);
      else groups.set(item.shareToken, [item]);
    }

    liveRows = new Map();
    const fragments: HTMLElement[] = [];
    for (const [token, all] of groups) {
      const shown = all
        .filter((i) => (filter === 'all' || GROUP_OF[i.state] === filter) && matches(i))
        .sort((a, b) => ORDER[GROUP_OF[a.state]] - ORDER[GROUP_OF[b.state]]);
      if (shown.length === 0) continue;
      fragments.push(renderGroup(token, all, shown));
    }
    $('queue-groups').replaceChildren(...fragments);

    const empty = $('queue-empty');
    empty.hidden = fragments.length > 0;
    empty.textContent = items.length === 0
      ? 'キューは空です。上の欄に共有URLを貼るか、共有ページのパネルから追加してください。'
      : '条件に合うファイルはありません。';
    updateLive();
  }

  function matches(item: QueueItem): boolean {
    if (!search) return true;
    return item.name.toLowerCase().includes(search) || item.relDir.toLowerCase().includes(search);
  }

  function renderGroup(token: string, all: QueueItem[], shown: QueueItem[]): HTMLElement {
    const s = summarizeQueue(all);
    const details = el('details', 'group');
    const unfinished = s.counts.active + s.counts.waiting + s.counts.error > 0;
    details.open = search !== '' || (openState.get(token) ?? unfinished);
    details.addEventListener('toggle', () => openState.set(token, details.open));

    const summary = el('summary');
    const name = el('span', 'group-name', all[0].shareName || token);
    name.title = `${all[0].shareName}（${token}）`;
    const stats = [`完了 ${s.counts.done} / ${s.total - s.counts.skipped}`];
    if (s.counts.active) stats.push(`処理中 ${s.counts.active}`);
    if (s.counts.error) stats.push(`失敗 ${s.counts.error}`);
    if (s.counts.skipped) stats.push(`省略 ${s.counts.skipped}`);
    stats.push(formatBytes(s.bytesTotal));
    const meter = el('div', 'meter group-meter');
    const fill = el('div');
    fill.style.width = `${percent(s.counts.done, s.total - s.counts.skipped)}%`;
    meter.append(fill);

    const actions = el('div', 'group-actions');
    if (s.counts.error) {
      const b = el('button', '', `失敗 ${s.counts.error}件を再試行`);
      run(b, () => must(send({ type: 'queue.retryFailed', token })), { inSummary: true });
      actions.append(b);
    }
    const waitingIds = all.filter((i) => GROUP_OF[i.state] === 'waiting').map((i) => i.id);
    if (waitingIds.length) {
      const b = el('button', '', `待ち ${waitingIds.length}件を取り消す`);
      run(
        b,
        async () => {
          if (!confirm(`「${all[0].shareName}」の待ち ${waitingIds.length}件をキューから外します。よろしいですか？`)) return;
          await must(send({ type: 'queue.removeMany', ids: waitingIds }));
        },
        { inSummary: true },
      );
      actions.append(b);
    }
    summary.append(name, el('span', 'group-stats', stats.join('・')), meter, actions);
    details.append(summary);

    // 閉じている共有は中身を作らない（件数が多いときに軽くするため）
    const fillBody = () => {
      if (details.querySelector('.items')) return;
      const limit = limits.get(token) ?? PAGE_SIZE;
      const list = el('ul', 'items');
      list.append(...shown.slice(0, limit).map(renderItem));
      details.append(list);
      if (shown.length > limit) {
        const more = el('button', 'more', `さらに表示（残り ${shown.length - limit}件）`);
        more.addEventListener('click', () => {
          limits.set(token, limit + PAGE_SIZE * 2);
          scheduleRender(0);
        });
        details.append(more);
      }
      updateLive();
    };
    if (details.open) fillBody();
    else details.addEventListener('toggle', fillBody, { once: true });
    return details;
  }

  function renderItem(item: QueueItem): HTMLLIElement {
    const group = GROUP_OF[item.state];
    const li = el('li', 'item');

    const name = el('div', 'name', item.name);
    name.append(el('div', 'sub', `${item.relDir}\\${item.outName}`));
    if (item.error && item.state !== 'done') name.append(el('div', 'err', item.error));

    const size = el('div', 'size', formatBytes(item.size));

    const state = el('div', `state st-${group}`);
    state.append(el('div', '', STATE_LABELS[item.state] + (item.note ? `（${item.note}）` : '')));
    if (item.state === 'downloading') {
      const meter = el('div', 'meter info');
      const bar = el('div');
      meter.append(bar);
      const text = el('div', 'live');
      state.append(meter, text);
      if (item.gid) liveRows.set(item.gid, { bar, text });
      // Motrixから取れるまでは、保存してある値で出しておく
      bar.style.width = `${percent(item.completedLength ?? 0, item.totalLength ?? item.size ?? 0)}%`;
    }

    const actions = el('div', 'actions');
    if (item.state === 'error' || item.state === 'skipped') {
      const b = el('button', '', item.state === 'skipped' ? '落とし直す' : '再試行');
      run(b, () => must(send({ type: 'queue.retry', id: item.id })));
      actions.append(b);
    }
    if (!ACTIVE_STATES.includes(item.state)) {
      const b = el('button', '', '削除');
      b.title = item.state === 'downloading' ? '一覧から外します（Motrixのダウンロードは続きます）' : '一覧から外します';
      run(b, () => must(send({ type: 'queue.remove', id: item.id })));
      actions.append(b);
    }

    li.append(name, size, state, actions);
    return li;
  }

  /** ダウンロード中の行の進み具合・速度・残り時間を書き換える */
  function updateLive() {
    for (const [gid, row] of liveRows) {
      const p = progress.get(gid);
      if (!p) continue;
      const pct = percent(p.completed, p.total);
      row.bar.style.width = `${pct}%`;
      row.text.textContent = `${pct.toFixed(1)}%・${formatSpeed(p.speed)}・残り ${formatEta(p.total - p.completed, p.speed)}`;
    }
  }

  function renderEvents() {
    const list = $('events');
    const shown = eventLevel === 'all' ? events : events.filter((e) => e.level !== 'info');
    if (shown.length === 0) {
      list.replaceChildren(el('li', 'muted', events.length ? '警告・エラーはありません' : 'まだ記録はありません'));
      return;
    }
    list.replaceChildren(
      ...shown.map((ev) => {
        const li = el('li', ev.level);
        const time = el('time');
        const d = new Date(ev.at);
        time.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
        li.append(time, el('span', '', ev.message));
        return li;
      }),
    );
  }

  return {
    /** 転送量が取れたら見積もりに使う */
    setTraffic(t: TrafficInfo | null) {
      traffic = t;
      renderOverview();
    },
  };
}
