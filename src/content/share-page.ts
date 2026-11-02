/**
 * Linkexの共有ページ（/f/<token>, l2e.click/d/<token>）に「キューに追加」パネルを出す。
 * ページのデザインに影響しないよう、Shadow DOM の中に描く。
 * このファイルは単体のスクリプトとしてビルドする（vite.content.config.ts）。
 */
import { formatBytes } from '../shared/files';
import type { Response } from '../shared/messages';
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
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 320px; max-width: calc(100vw - 32px);
  font: 13px/1.5 'Segoe UI', 'Yu Gothic UI', 'Meiryo', sans-serif;
  color: #e6e9ed; background: #1e2227; border: 1px solid #2f353c; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.35); padding: 12px;
}
.panel.collapsed { width: auto; padding: 6px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title { font-weight: 600; }
button {
  font: inherit; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid #2f353c; background: #15181c; color: #e6e9ed;
}
button:hover:not(:disabled) { border-color: #2fb57f; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: #2fb57f; border-color: #2fb57f; color: #0d1512; }
button.icon { padding: 2px 8px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.check { display: flex; align-items: center; gap: 6px; margin-top: 10px; color: #98a2ad; }
.status { margin-top: 10px; color: #98a2ad; white-space: pre-wrap; }
.status.ok { color: #2fb57f; }
.status.ng { color: #e26161; }
.list { margin-top: 10px; max-height: 280px; overflow: auto; border-top: 1px solid #2f353c; }
.item { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #2f353c; align-items: flex-start; }
.item .name { flex: 1; word-break: break-all; }
.item .sub { color: #98a2ad; font-size: 11px; }
.item .size { color: #98a2ad; white-space: nowrap; }
`;

function mount(token: string) {
  const host = document.createElement('div');
  host.id = 'linkex-motrix-panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="panel">
      <div class="head">
        <span class="title">Linkex Motrix</span>
        <button class="icon" data-act="collapse" title="小さくする">－</button>
      </div>
      <div class="body">
        <div class="row">
          <button class="primary" data-act="all">全部キューに追加</button>
          <button data-act="pick">選んで追加</button>
        </div>
        <label class="check"><input type="checkbox" data-act="autostart" checked /> 追加したら開始する</label>
        <div class="list" hidden></div>
        <div class="row pick-actions" hidden>
          <button class="primary" data-act="add-selected">選んだファイルを追加</button>
          <label class="check" style="margin: 0"><input type="checkbox" data-act="select-all" checked /> すべて選択</label>
        </div>
        <div class="status"></div>
        <div class="row"><button data-act="dashboard">専用ページを開く</button></div>
      </div>
    </div>`;
  document.documentElement.append(host);

  const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const panel = q<HTMLDivElement>('.panel');
  const body = q<HTMLDivElement>('.body');
  const status = q<HTMLDivElement>('.status');
  const list = q<HTMLDivElement>('.list');
  const pickActions = q<HTMLDivElement>('.pick-actions');
  const autostart = q<HTMLInputElement>('[data-act="autostart"]');
  let walked: { shareName: string; files: WalkedFile[] } | null = null;

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

  const afterAdd = async (added: number, already: number) => {
    let text = `${added}件をキューに追加しました${already ? `（すでにあった ${already}件）` : ''}`;
    if (autostart.checked && added > 0) {
      const res = await send({ type: 'queue.start' });
      text += res.ok ? '。処理を開始しました' : `。開始できませんでした: ${res.error}`;
    }
    setStatus(text, 'ok');
  };

  q<HTMLButtonElement>('[data-act="collapse"]').addEventListener('click', (ev) => {
    const collapsed = panel.classList.toggle('collapsed');
    body.hidden = collapsed;
    q<HTMLSpanElement>('.title').hidden = collapsed;
    (ev.currentTarget as HTMLButtonElement).textContent = collapsed ? '＋' : '－';
    (ev.currentTarget as HTMLButtonElement).title = collapsed ? 'Linkex Motrix を開く' : '小さくする';
  });

  const allButton = q<HTMLButtonElement>('[data-act="all"]');
  allButton.addEventListener('click', () =>
    busy(allButton, async () => {
      setStatus('共有の中身を読み込み中…');
      const res = await send<{ added: number; alreadyQueued: number; failed: { error: string }[] }>({
        type: 'queue.add',
        text: token,
      });
      if (!res.ok) throw new Error(res.error);
      if (res.data.failed.length) throw new Error(`読み込めませんでした: ${res.data.failed[0].error}`);
      await afterAdd(res.data.added, res.data.alreadyQueued);
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
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = f.name;
          if (f.folders.length) {
            const sub = document.createElement('div');
            sub.className = 'sub';
            sub.textContent = f.folders.join(' / ');
            name.append(sub);
          }
          const size = document.createElement('span');
          size.className = 'size';
          size.textContent = formatBytes(f.size);
          row.append(box, name, size);
          return row;
        }),
      );
      list.hidden = false;
      pickActions.hidden = false;
      q<HTMLInputElement>('[data-act="select-all"]').checked = true;
      setStatus(`${walked.files.length}件のファイルがあります`);
    }),
  );

  q<HTMLInputElement>('[data-act="select-all"]').addEventListener('change', (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((b) => (b.checked = checked));
  });

  const addSelected = q<HTMLButtonElement>('[data-act="add-selected"]');
  addSelected.addEventListener('click', () =>
    busy(addSelected, async () => {
      if (!walked) return;
      const files = Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
        .map((b) => walked!.files[Number(b.dataset.index)])
        .filter(Boolean);
      if (files.length === 0) throw new Error('ファイルが選ばれていません');
      const res = await send<{ added: number; alreadyQueued: number }>({
        type: 'queue.addFiles',
        token,
        shareName: walked.shareName,
        files,
      });
      if (!res.ok) throw new Error(res.error);
      await afterAdd(res.data.added, res.data.alreadyQueued);
    }),
  );

  q<HTMLButtonElement>('[data-act="dashboard"]').addEventListener('click', () => {
    void send({ type: 'dashboard.open' });
  });

  return host;
}

// 共有ページはページ遷移せずにURLが変わることがあるので、URLの変化を見て付け直す
let current: { token: string; host: HTMLElement } | null = null;
function sync() {
  const token = parseShareToken(location.href);
  if (current && current.token === token) return;
  current?.host.remove();
  current = token ? { token, host: mount(token) } : null;
}
sync();
setInterval(sync, 1000);
