/**
 * Linkexの共有ページ（/f/<token>, l2e.click/d/<token>）に「キューに追加」パネルを出す。
 * ページのデザインに影響しないよう、Shadow DOM の中に描く。
 * このファイルは単体のスクリプトとしてビルドする（vite.content.config.ts）。
 */
import { formatBytes, formatEta, formatSpeed, percent } from '../shared/format';
import type { MotrixLive, Response } from '../shared/messages';
import {
  ENGINE_KEY,
  GROUP_OF,
  QUEUE_KEY,
  STATE_LABELS,
  summarizeQueue,
  type EngineState,
  type QueueItem,
} from '../shared/queue';
import { parseShareToken } from '../shared/share-url';
import { engineView } from '../ui/live';

interface WalkProgress {
  phase?: 'tab';
  files: number;
  bytes: number;
  folders: number;
}

interface WalkedFile {
  id: string;
  name: string;
  size: number | null;
  hash: string | null;
  folders: string[];
}

function send<T>(message: unknown): Promise<Response<T>> {
  return chrome.runtime
    .sendMessage(message)
    .then((res) => (res as Response<T> | undefined) ?? { ok: false as const, error: 'no_response' })
    .catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
}

const LOGO = `<svg viewBox="0 0 128 128" aria-hidden="true"><defs><linearGradient id="lm-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ab880"/><stop offset="1" stop-color="#168258"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#lm-g)"/><g fill="#fff"><rect x="54" y="20" width="20" height="46"/><polygon points="30,58 98,58 64,94"/><rect x="28" y="100" width="72" height="12" rx="6"/></g></svg>`;

const ICON_MINUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg>';
const ICON_PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>';

const STYLE = `
:host { all: initial; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.panel {
  /* src/ui/style.css の共通の土台と同じ値。変えるときはそろえる */
  --bg: #ffffff; --soft: #eef1f4; --text: #1d2228; --muted: #5d6874; --border: #dde1e6;
  --ok: #276b2b; --ok-soft: #e4f1e5; --warn: #8f5400; --warn-soft: #fcf0da;
  --danger: #c0392b; --danger-soft: #fbe8e6; --info: #1f63a8; --info-soft: #e5eef8;
  --accent: #0b7a5c; --accent-hover: #096a50; --accent-strong: #0a6b51; --accent-soft: #e0f2eb; --on-accent: #ffffff;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 340px; max-width: calc(100vw - 32px);
  font: 13px/1.5 'Segoe UI', 'Yu Gothic UI', 'Meiryo', system-ui, sans-serif; font-variant-numeric: tabular-nums;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 12px 32px rgba(16,24,32,.16), 0 2px 6px rgba(16,24,32,.06); overflow: hidden;
  display: flex; flex-direction: column; max-height: calc(100vh - 32px);
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #1e2227; --soft: #262b31; --text: #e6e9ed; --muted: #9ca6b1; --border: #333a42;
    --ok: #74c47a; --ok-soft: #1c3320; --warn: #e8ad52; --warn-soft: #3a2d16;
    --danger: #f0827a; --danger-soft: #3d2323; --info: #74aef0; --info-soft: #1c2c40;
    --accent: #2fb57f; --accent-hover: #4cc794; --accent-strong: #6fd8aa; --accent-soft: #17362a; --on-accent: #0d1512;
    box-shadow: 0 12px 32px rgba(0,0,0,.5);
  }
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 12px; border-bottom: 1px solid var(--border); }
.logo { width: 20px; height: 20px; flex: none; display: block; }
.logo svg { width: 100%; height: 100%; display: block; }
.title { font-weight: 700; flex: 1; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--soft); color: var(--muted); white-space: nowrap; }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.running { background: var(--info-soft); color: var(--info); }
.pill.waiting { background: var(--warn-soft); color: var(--warn); }
.body { padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow: auto; min-height: 0; }
.body > * { flex-shrink: 0; }

/* 小さくしたとき */
.panel.collapsed { width: auto; border-radius: 999px; }
.panel.collapsed .head { border-bottom: 0; padding: 5px 5px 5px 8px; }
.panel.collapsed .title, .panel.collapsed .pill { display: none; }
.mini { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mini .ring { width: 16px; height: 16px; border-radius: 50%; background: conic-gradient(var(--accent) var(--p, 0%), var(--border) 0); -webkit-mask: radial-gradient(circle, transparent 4.5px, #000 5px); mask: radial-gradient(circle, transparent 4.5px, #000 5px); }

button {
  font: inherit; font-weight: 600; min-height: 32px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
button.primary:disabled { opacity: 1; background: var(--accent-soft); border-color: transparent; color: var(--accent-strong); }
input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
button.icon { padding: 0; min-height: 0; width: 28px; height: 28px; background: transparent; border-color: transparent; color: var(--muted); border-radius: 6px; }
button.icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
button.icon:hover:not(:disabled) { background: var(--soft); border-color: var(--border); color: var(--text); }
button.link { border: 0; background: transparent; color: var(--muted); padding: 2px 0; min-height: 28px; font-weight: 500; }
button.link:hover:not(:disabled) { color: var(--text); text-decoration: underline; }
button[data-icon]::before { content: ""; display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: -0.5px; background: currentColor; }
button[data-icon="play"]::before { clip-path: polygon(10% 0, 100% 50%, 10% 100%); }
button[data-icon="pause"]::before { clip-path: polygon(0 0, 35% 0, 35% 100%, 0 100%, 0 0, 65% 0, 100% 0, 100% 100%, 65% 100%, 65% 0); }

.share { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 10px; background: var(--info-soft); }
.share .label { font-size: 11px; color: var(--muted); font-weight: 600; }
.share .value { font-weight: 700; font-variant-numeric: tabular-nums; }
.actions { display: grid; grid-template-columns: 1.4fr 1fr; gap: 6px; }
.check { display: flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; font-size: 12px; }
.status { color: var(--muted); white-space: pre-wrap; font-size: 12px; }
.status:empty { display: none; }
.status.ok { color: var(--ok); }
.status.ng { color: var(--danger); }

/* このリンクの進み具合 */
.progress { padding: 10px; background: var(--soft); border-radius: 10px; }
.p-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; }
.p-pct { font-size: 26px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.5px; }
.p-pct small { font-size: 13px; color: var(--muted); font-weight: 600; margin-left: 1px; }
.p-side { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.p-side .p-count { font-weight: 600; }
.p-side .p-bytes { color: var(--muted); }
.meter { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 8px; }
.meter > div { height: 100%; background: var(--accent); transition: width .4s; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 8px; }
.tile { background: var(--bg); border-radius: 7px; padding: 4px 7px; display: flex; flex-direction: column; min-width: 0; }
.tile .label { color: var(--muted); font-size: 11px; }
.tile .value { font-weight: 600; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.counts { display: flex; gap: 2px 10px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--muted); }
.counts span { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
.counts span::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.counts b { color: var(--text); font-weight: 600; }
.counts .c-active { color: var(--info); }
.counts .c-done { color: var(--ok); }
.counts .c-error { color: var(--danger); }

.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.foot button[data-act="toggle"] { min-height: 30px; padding: 3px 12px; font-size: 12px; }

/* 選んで追加 */
.pick-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.pick-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.list { max-height: min(300px, 45vh); overflow: auto; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; }
.item { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); align-items: flex-start; cursor: pointer; }
.item:last-child { border-bottom: 0; }
.item.queued { cursor: default; opacity: .65; }
.item .name { flex: 1; min-width: 0; word-break: break-all; font-size: 12px; }
.item .sub { color: var(--muted); font-size: 11px; }
.item .tag { color: var(--info); font-size: 11px; }
.item .tag:empty { display: none; }
.item .tag.ng { color: var(--danger); }
.item .size { color: var(--muted); white-space: nowrap; font-size: 11px; font-variant-numeric: tabular-nums; }
.pick-actions { display: flex; gap: 6px; }
.pick-actions .primary { flex: 1; }
`;

function mount(token: string): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  host.id = 'linkex-motrix-panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="panel">
      <div class="head">
        <span class="logo">${LOGO}</span>
        <span class="title">Linkex Motrix</span>
        <span class="mini" hidden><span class="ring"></span><span class="mini-text"></span></span>
        <span class="pill engine-pill">停止中</span>
        <button class="icon" data-act="collapse" title="小さくする" aria-label="小さくする"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg></button>
      </div>
      <div class="body">
        <div class="share" hidden>
          <span class="label">この共有</span>
          <span class="value share-size"></span>
        </div>
        <div class="actions">
          <button class="primary" data-act="all">全部キューに追加</button>
          <button data-act="pick">選んで追加</button>
        </div>
        <label class="check"><input type="checkbox" data-act="autostart" checked /> 追加したら開始する</label>
        <div class="pick-head" hidden>
          <label class="check"><input type="checkbox" data-act="select-all" checked /> すべて選択</label>
          <span class="pick-count"></span>
        </div>
        <div class="list" hidden></div>
        <div class="pick-actions" hidden>
          <button class="primary" data-act="add-selected">選んだファイルを追加</button>
          <button data-act="pick-cancel">やめる</button>
        </div>
        <div class="status"></div>
        <div class="progress" hidden>
          <div class="p-top">
            <div class="p-pct"></div>
            <div class="p-side"><div class="p-count"></div><div class="p-bytes"></div></div>
          </div>
          <div class="meter"><div class="p-bar" style="width: 0"></div></div>
          <div class="tiles" hidden>
            <div class="tile"><span class="label">速度</span><span class="value t-speed">-</span></div>
            <div class="tile"><span class="label">残り</span><span class="value t-left">-</span></div>
            <div class="tile"><span class="label">残り時間</span><span class="value t-eta">-</span></div>
          </div>
          <div class="counts"></div>
        </div>
        <div class="foot">
          <button class="link" data-act="dashboard">専用ページを開く</button>
          <button data-act="toggle" hidden>開始</button>
        </div>
      </div>
    </div>`;
  document.documentElement.append(host);

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const panel = q<HTMLDivElement>('.panel');
  const body = q<HTMLDivElement>('.body');
  const status = q<HTMLDivElement>('.status');
  const list = q<HTMLDivElement>('.list');
  const pickActions = q<HTMLDivElement>('.pick-actions');
  const pickHead = q<HTMLDivElement>('.pick-head');
  const autostart = q<HTMLInputElement>('[data-act="autostart"]');
  const selectAll = q<HTMLInputElement>('[data-act="select-all"]');
  const mini = q<HTMLSpanElement>('.head .mini');
  let walked: { shareName: string; files: WalkedFile[] } | null = null;
  /** このリンクのファイルで、キューに入っているもの（共有側のID → 件） */
  let queued = new Map<string, QueueItem>();

  const setStatus = (text: string, kind: '' | 'ok' | 'ng' = '') => {
    status.textContent = text;
    status.className = `status ${kind}`;
  };

  const busy = async (button: HTMLButtonElement, fn: () => Promise<void>) => {
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      setStatus(String((e as Error)?.message ?? e), 'ng');
    } finally {
      button.disabled = false;
    }
  };

  const afterAdd = async (added: number, addedBytes: number, already: number) => {
    let text = `${added}件（${formatBytes(addedBytes)}）をキューに追加しました${already ? `（すでにあった ${already}件）` : ''}`;
    if (added === 0 && already > 0) text = `すべてキューに入っています（${already}件）`;
    if (autostart.checked && added > 0) {
      const res = await send({ type: 'queue.start' });
      text += res.ok ? '。処理を開始しました' : `。開始できませんでした: ${res.error}`;
    }
    setStatus(text, 'ok');
  };

  // ---------- 小さくする（状態は覚えておく） ----------
  const collapseButton = q<HTMLButtonElement>('[data-act="collapse"]');
  const isCollapsed = () => panel.classList.contains('collapsed');
  const setCollapsed = (collapsed: boolean) => {
    panel.classList.toggle('collapsed', collapsed);
    body.hidden = collapsed;
    mini.hidden = !collapsed || !q('.mini-text').textContent;
    collapseButton.innerHTML = collapsed ? ICON_PLUS : ICON_MINUS;
    collapseButton.title = collapsed ? 'Linkex Motrix を開く' : '小さくする';
    collapseButton.setAttribute('aria-label', collapseButton.title);
  };
  collapseButton.addEventListener('click', () => {
    const collapsed = !isCollapsed();
    setCollapsed(collapsed);
    void chrome.storage.local.set({ panelCollapsed: collapsed });
  });
  void chrome.storage.local.get('panelCollapsed').then((v) => setCollapsed(v.panelCollapsed === true));

  // ---------- この共有の大きさ ----------
  const showShareSize = (files: WalkedFile[]) => {
    const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    const unknown = files.filter((f) => f.size == null).length;
    q('.share-size').textContent = `${files.length.toLocaleString()}件・${formatBytes(bytes)}${unknown ? `（不明 ${unknown}件）` : ''}`;
    q('.share').hidden = false;
  };

  // ---------- 全体の状態（実行中・停止中） ----------
  let engine: EngineState | undefined;
  const toggleButton = q<HTMLButtonElement>('[data-act="toggle"]');
  const renderEngine = () => {
    const view = engineView(engine, mine);
    const pill = q('.engine-pill');
    pill.textContent = view.pill;
    pill.className = `pill engine-pill ${view.tone}`;
    pill.title = view.message;
    toggleButton.textContent = view.paused ? '開始' : '一時停止';
    toggleButton.dataset.icon = view.paused ? 'play' : 'pause';
    toggleButton.className = view.paused ? 'primary' : '';
  };
  toggleButton.addEventListener('click', () =>
    busy(toggleButton, async () => {
      const res = await send({ type: engine?.paused === false ? 'queue.pause' : 'queue.start' });
      if (!res.ok) throw new Error(res.error);
    }),
  );

  // ---------- このリンクの進み具合 ----------
  let mine: QueueItem[] = [];
  /** Motrixから取った今の進み具合（gid → 取得済みバイト・速度） */
  let live = new Map<string, { completed: number; speed: number }>();

  const chip = (cls: string, label: string, n: number) => {
    const e = document.createElement('span');
    e.className = cls;
    const b = document.createElement('b');
    b.textContent = String(n);
    e.append(`${label} `, b);
    return e;
  };

  const renderProgress = () => {
    const box = q<HTMLDivElement>('.progress');
    box.hidden = mine.length === 0;
    toggleButton.hidden = mine.length === 0;
    if (mine.length === 0) {
      q('.mini-text').textContent = '';
      mini.hidden = true;
      return;
    }
    const completed = new Map([...live].map(([gid, p]) => [gid, p.completed]));
    const s = summarizeQueue(mine, completed);
    const target = mine.length - s.counts.skipped;
    const pct = percent(s.bytesDone, s.bytesTotal);
    q('.p-pct').innerHTML = `${Math.floor(pct)}<small>%</small>`;
    q('.p-count').textContent = `${s.counts.done} / ${target}件 完了`;
    q('.p-bytes').textContent = `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`;
    q('.p-bar').style.width = `${pct}%`;

    let speed = 0;
    for (const item of mine) if (item.gid) speed += live.get(item.gid)?.speed ?? 0;
    const busyNow = s.counts.active + s.counts.waiting > 0;
    q('.tiles').hidden = !busyNow;
    q('.t-speed').textContent = speed > 0 ? formatSpeed(speed) : '-';
    q('.t-left').textContent = s.bytesRemaining > 0 ? formatBytes(s.bytesRemaining) : '-';
    q('.t-eta').textContent = s.bytesRemaining > 0 && speed > 0 ? formatEta(s.bytesRemaining, speed) : '-';

    q('.counts').replaceChildren(
      ...[
        s.counts.active ? chip('c-active', '処理中', s.counts.active) : null,
        s.counts.waiting ? chip('c-waiting', '待ち', s.counts.waiting) : null,
        chip('c-done', '完了', s.counts.done),
        s.counts.skipped ? chip('c-skipped', '省略', s.counts.skipped) : null,
        s.counts.error ? chip('c-error', '失敗', s.counts.error) : null,
      ].filter((c): c is HTMLSpanElement => c !== null),
    );

    q('.mini-text').textContent = `${Math.floor(pct)}%・${s.counts.done}/${target}`;
    q<HTMLSpanElement>('.ring').style.setProperty('--p', `${pct}%`);
    mini.hidden = !isCollapsed();
  };

  const onQueue = (all: QueueItem[]) => {
    mine = all.filter((i) => i.shareToken === token);
    queued = new Map(mine.map((i) => [i.sourceFileId, i]));
    if (walked && !list.hidden) markQueued();
    renderProgress();
  };

  // ダウンロード中のファイルがあり、ページが見えているときだけ、Motrixに速度を聞きに行く
  const speedTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !mine.some((i) => i.state === 'downloading')) {
      if (live.size) {
        live = new Map();
        renderProgress();
      }
      return;
    }
    const res = await send<MotrixLive>({ type: 'motrix.active' });
    live = new Map(
      res.ok ? res.data.active.map((a) => [a.gid, { completed: a.completedLength, speed: a.downloadSpeed }]) : [],
    );
    renderProgress();
  }, 1500);

  void chrome.storage.local.get([QUEUE_KEY, ENGINE_KEY]).then((v) => {
    engine = v[ENGINE_KEY] as EngineState | undefined;
    renderEngine();
    onQueue((v[QUEUE_KEY] as QueueItem[] | undefined) ?? []);
  });
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (changes[QUEUE_KEY]) onQueue((changes[QUEUE_KEY].newValue as QueueItem[] | undefined) ?? []);
    if (changes[ENGINE_KEY]) {
      engine = changes[ENGINE_KEY].newValue as EngineState | undefined;
      renderEngine();
    }
    if (changes.walkProgress && loading) {
      const p = (changes.walkProgress.newValue as Record<string, WalkProgress> | undefined)?.[token];
      if (p?.phase === 'tab') setStatus('Linkexのタブを準備中…');
      else if (p) setStatus(`共有の中身を読み込み中… ${p.files.toLocaleString()}件・${formatBytes(p.bytes)}（フォルダ ${p.folders}）`);
    }
  };
  chrome.storage.onChanged.addListener(onStorage);

  // ---------- 共有の中身を読む ----------
  /** 読み込み中か（途中経過を表示するため） */
  let loading = false;
  /** 押す前（マウスを乗せたとき）に読み始めておく。結果は Service Worker が覚えていて、押したときに使われる */
  let prefetched = false;
  const prefetch = () => {
    if (prefetched) return;
    prefetched = true;
    void send<{ shareName: string; files: WalkedFile[] }>({ type: 'share.walk', token }).then((res) => {
      if (res.ok) showShareSize(res.data.files);
      else prefetched = false;
    });
  };
  const withLoading = async <T>(fn: () => Promise<T>): Promise<T> => {
    loading = true;
    setStatus('共有の中身を読み込み中…');
    try {
      return await fn();
    } finally {
      loading = false;
    }
  };

  // ---------- 選んで追加 ----------
  const boxes = () => Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

  const updatePickCount = () => {
    if (!walked) return;
    const selectable = boxes().filter((b) => !b.disabled);
    const checked = selectable.filter((b) => b.checked);
    const bytes = checked.reduce((sum, b) => sum + (walked!.files[Number(b.dataset.index)]?.size ?? 0), 0);
    q('.pick-count').textContent = `${checked.length} / ${selectable.length}件・${formatBytes(bytes)}`;
    selectAll.checked = selectable.length > 0 && checked.length === selectable.length;
    q<HTMLButtonElement>('[data-act="add-selected"]').disabled = checked.length === 0;
  };

  /** キューに入っているファイルに印を付けて、選べないようにする。選べる件数を返す */
  const markQueued = (): number => {
    let selectable = 0;
    for (const box of boxes()) {
      const file = walked!.files[Number(box.dataset.index)];
      const row = box.closest('.item')!;
      const tag = row.querySelector('.tag')!;
      const item = queued.get(file.id);
      row.classList.toggle('queued', !!item);
      box.disabled = !!item;
      if (item) {
        box.checked = false;
        tag.textContent = `キューにあり（${STATE_LABELS[item.state]}）`;
        tag.className = `tag${GROUP_OF[item.state] === 'error' ? ' ng' : ''}`;
      } else {
        tag.textContent = '';
        selectable++;
      }
    }
    updatePickCount();
    return selectable;
  };

  const closePick = () => {
    list.hidden = true;
    pickActions.hidden = true;
    pickHead.hidden = true;
  };

  const allButton = q<HTMLButtonElement>('[data-act="all"]');
  allButton.addEventListener('click', () =>
    busy(allButton, async () => {
      closePick();
      const res = await withLoading(() =>
        send<{ added: number; addedBytes: number; alreadyQueued: number; failed: { error: string }[] }>({
          type: 'queue.add',
          text: token,
        }),
      );
      if (!res.ok) throw new Error(res.error);
      if (res.data.failed.length) throw new Error(`読み込めませんでした: ${res.data.failed[0].error}`);
      await afterAdd(res.data.added, res.data.addedBytes, res.data.alreadyQueued);
    }),
  );

  const pickButton = q<HTMLButtonElement>('[data-act="pick"]');
  for (const b of [allButton, pickButton]) {
    b.addEventListener('pointerenter', prefetch);
    b.addEventListener('focus', prefetch);
  }
  pickButton.addEventListener('click', () =>
    busy(pickButton, async () => {
      const res = await withLoading(() => send<{ shareName: string; files: WalkedFile[] }>({ type: 'share.walk', token }));
      if (!res.ok) throw new Error(res.error);
      walked = res.data;
      showShareSize(walked.files);
      list.replaceChildren(
        ...walked.files.map((f, index) => {
          const row = document.createElement('label');
          row.className = 'item';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = true;
          box.dataset.index = String(index);
          box.addEventListener('change', updatePickCount);
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = f.name;
          if (f.folders.length) {
            const sub = document.createElement('div');
            sub.className = 'sub';
            sub.textContent = f.folders.join(' / ');
            name.append(sub);
          }
          const tag = document.createElement('div');
          tag.className = 'tag';
          name.append(tag);
          const size = document.createElement('span');
          size.className = 'size';
          size.textContent = formatBytes(f.size);
          row.append(box, name, size);
          return row;
        }),
      );
      list.hidden = false;
      pickActions.hidden = false;
      pickHead.hidden = false;
      const selectable = markQueued();
      const already = walked.files.length - selectable;
      // 全体の件数とサイズは「この共有」の欄に出している
      setStatus(already ? `うち ${already}件はキューにあり` : '');
    }),
  );

  selectAll.addEventListener('change', () => {
    for (const b of boxes()) if (!b.disabled) b.checked = selectAll.checked;
    updatePickCount();
  });

  q<HTMLButtonElement>('[data-act="pick-cancel"]').addEventListener('click', () => {
    closePick();
    setStatus('');
  });

  const addSelected = q<HTMLButtonElement>('[data-act="add-selected"]');
  addSelected.addEventListener('click', () =>
    busy(addSelected, async () => {
      if (!walked) return;
      const files = boxes()
        .filter((b) => b.checked && !b.disabled)
        .map((b) => walked!.files[Number(b.dataset.index)])
        .filter(Boolean);
      if (files.length === 0) throw new Error('ファイルが選ばれていません');
      const res = await send<{ added: number; addedBytes: number; alreadyQueued: number }>({
        type: 'queue.addFiles',
        token,
        shareName: walked.shareName,
        files,
      });
      if (!res.ok) throw new Error(res.error);
      closePick();
      await afterAdd(res.data.added, res.data.addedBytes, res.data.alreadyQueued);
    }),
  );

  q<HTMLButtonElement>('[data-act="dashboard"]').addEventListener('click', () => {
    void send({ type: 'dashboard.open' });
  });

  return {
    host,
    dispose: () => {
      chrome.storage.onChanged.removeListener(onStorage);
      clearInterval(speedTimer);
    },
  };
}

// 共有ページはページ遷移せずにURLが変わることがあるので、URLの変化を見て付け直す
let current: { token: string; host: HTMLElement; dispose: () => void } | null = null;
function sync() {
  const token = parseShareToken(location.href);
  if (current && current.token === token) return;
  current?.host.remove();
  current?.dispose();
  current = token ? { token, ...mount(token) } : null;
}
sync();
setInterval(sync, 1000);
