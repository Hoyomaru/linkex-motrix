/**
 * Linkexの共有ページ（/f/<token>, l2e.click/d/<token>）に「キューに追加」パネルを出す。
 * ページのデザインに影響しないよう、Shadow DOM の中に描く。
 * このファイルは単体のスクリプトとしてビルドする（vite.content.config.ts）。
 */
import { formatBytes } from '../shared/files';
import type { Response } from '../shared/messages';
import { GROUP_OF, QUEUE_KEY, STATE_LABELS, summarizeQueue, type QueueItem } from '../shared/queue';
import { parseShareToken } from '../shared/share-url';

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

const STYLE = `
:host { all: initial; }
[hidden] { display: none !important; }
.panel {
  --bg: #ffffff; --soft: #f3f5f7; --text: #1d2228; --muted: #65707c; --border: #dde1e6;
  --accent: #1f9d6b; --accent-text: #ffffff; --danger: #c93c3c; --info: #2b6cb0;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 340px; max-width: calc(100vw - 32px);
  font: 13px/1.5 'Segoe UI', 'Yu Gothic UI', 'Meiryo', sans-serif;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); padding: 12px;
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #1e2227; --soft: #262b31; --text: #e6e9ed; --muted: #98a2ad; --border: #2f353c;
    --accent: #2fb57f; --accent-text: #0d1512; --danger: #e26161; --info: #63a4e8;
    box-shadow: 0 8px 28px rgba(0,0,0,.45);
  }
}
.panel.collapsed { width: auto; padding: 6px 8px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title { font-weight: 600; }
.mini { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
button {
  font: inherit; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border); background: var(--soft); color: var(--text);
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.icon { padding: 1px 8px; background: transparent; }
button.link { border: 0; background: transparent; color: var(--muted); padding: 2px 0; text-decoration: underline; }
.row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.check { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--muted); cursor: pointer; }
.status { margin-top: 8px; color: var(--muted); white-space: pre-wrap; }
.status:empty { display: none; }
.status.ok { color: var(--accent); }
.status.ng { color: var(--danger); }
.progress { margin-top: 10px; padding: 8px 10px; background: var(--soft); border-radius: 8px; }
.progress .line { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
.progress .err { color: var(--danger); }
.meter { height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 6px; }
.meter > div { height: 100%; background: var(--accent); transition: width .4s; }
.pick-head { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; gap: 8px; }
.list { margin-top: 6px; max-height: 300px; overflow: auto; border-top: 1px solid var(--border); }
.item { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); align-items: flex-start; cursor: pointer; }
.item.queued { cursor: default; opacity: .65; }
.item .name { flex: 1; min-width: 0; word-break: break-all; }
.item .sub { color: var(--muted); font-size: 11px; }
.item .tag { color: var(--info); font-size: 11px; }
.item .tag:empty { display: none; }
.item .tag.ng { color: var(--danger); }
.item .size { color: var(--muted); white-space: nowrap; font-size: 12px; }
`;

function mount(token: string): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  host.id = 'linkex-motrix-panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="panel">
      <div class="head">
        <span class="title">Linkex Motrix</span>
        <span class="mini" hidden></span>
        <button class="icon" data-act="collapse" title="小さくする">－</button>
      </div>
      <div class="body">
        <div class="row">
          <button class="primary" data-act="all">全部キューに追加</button>
          <button data-act="pick">選んで追加</button>
        </div>
        <label class="check"><input type="checkbox" data-act="autostart" checked /> 追加したら開始する</label>
        <div class="pick-head" hidden>
          <label class="check" style="margin: 0"><input type="checkbox" data-act="select-all" checked /> すべて選択</label>
          <span class="mini pick-count"></span>
        </div>
        <div class="list" hidden></div>
        <div class="row pick-actions" hidden>
          <button class="primary" data-act="add-selected">選んだファイルを追加</button>
          <button data-act="pick-cancel">やめる</button>
        </div>
        <div class="status"></div>
        <div class="progress" hidden>
          <div class="line"><span class="p-count"></span><span class="p-bytes"></span></div>
          <div class="meter"><div class="p-bar" style="width: 0"></div></div>
          <div class="line" style="margin-top: 4px"><span class="p-state"></span><span class="p-err err"></span></div>
        </div>
        <div class="row"><button class="link" data-act="dashboard">専用ページを開く</button></div>
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
  const setCollapsed = (collapsed: boolean) => {
    panel.classList.toggle('collapsed', collapsed);
    body.hidden = collapsed;
    q('.title').hidden = collapsed;
    mini.hidden = !collapsed || !mini.textContent;
    collapseButton.textContent = collapsed ? '＋' : '－';
    collapseButton.title = collapsed ? 'Linkex Motrix を開く' : '小さくする';
  };
  collapseButton.addEventListener('click', () => {
    const collapsed = !panel.classList.contains('collapsed');
    setCollapsed(collapsed);
    void chrome.storage.local.set({ panelCollapsed: collapsed });
  });
  void chrome.storage.local.get('panelCollapsed').then((v) => setCollapsed(v.panelCollapsed === true));

  // ---------- このリンクの進み具合 ----------
  const renderProgress = (all: QueueItem[]) => {
    const mine = all.filter((i) => i.shareToken === token);
    queued = new Map(mine.map((i) => [i.sourceFileId, i]));
    if (walked && !list.hidden) markQueued();
    const box = q<HTMLDivElement>('.progress');
    box.hidden = mine.length === 0;
    if (mine.length === 0) {
      mini.textContent = '';
      mini.hidden = true;
      return;
    }
    const s = summarizeQueue(mine);
    const target = mine.length - s.counts.skipped;
    q('.p-count').textContent = `このリンク: ${s.counts.done} / ${target}件 完了`;
    q('.p-bytes').textContent = `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`;
    q('.p-bar').style.width = `${target ? (s.counts.done / target) * 100 : 0}%`;
    const parts: string[] = [];
    if (s.counts.active) parts.push(`処理中 ${s.counts.active}`);
    if (s.counts.waiting) parts.push(`待ち ${s.counts.waiting}`);
    if (s.counts.skipped) parts.push(`省略 ${s.counts.skipped}`);
    q('.p-state').textContent = parts.join('・') || (s.counts.done === target && !s.counts.error ? 'すべて完了' : '');
    q('.p-err').textContent = s.counts.error ? `失敗 ${s.counts.error}` : '';
    mini.textContent = `${s.counts.done}/${target}`;
    mini.hidden = !panel.classList.contains('collapsed');
  };
  void chrome.storage.local.get(QUEUE_KEY).then((v) => renderProgress((v[QUEUE_KEY] as QueueItem[] | undefined) ?? []));
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[QUEUE_KEY]) {
      renderProgress((changes[QUEUE_KEY].newValue as QueueItem[] | undefined) ?? []);
    }
  };
  chrome.storage.onChanged.addListener(onStorage);

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
      setStatus('共有の中身を読み込み中…');
      const res = await send<{ added: number; addedBytes: number; alreadyQueued: number; failed: { error: string }[] }>({
        type: 'queue.add',
        text: token,
      });
      if (!res.ok) throw new Error(res.error);
      if (res.data.failed.length) throw new Error(`読み込めませんでした: ${res.data.failed[0].error}`);
      await afterAdd(res.data.added, res.data.addedBytes, res.data.alreadyQueued);
    }),
  );

  const pickButton = q<HTMLButtonElement>('[data-act="pick"]');
  pickButton.addEventListener('click', () =>
    busy(pickButton, async () => {
      setStatus('共有の中身を読み込み中…');
      const res = await send<{ shareName: string; files: WalkedFile[] }>({ type: 'share.walk', token });
      if (!res.ok) throw new Error(res.error);
      walked = res.data;
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
      const total = walked.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
      const unknown = walked.files.filter((f) => f.size == null).length;
      setStatus(
        `全部で ${walked.files.length}件・${formatBytes(total)}${unknown ? `（サイズ不明 ${unknown}件）` : ''}` +
          `${already ? `
うち ${already}件はキューにあり` : ''}`,
      );
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

  return { host, dispose: () => chrome.storage.onChanged.removeListener(onStorage) };
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
