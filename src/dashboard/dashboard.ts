import { send } from '../shared/messages';
import { formatBytes, isFolder, linkexApi, unwrapFile } from '../shared/linkex-api';
import type { Settings } from '../shared/settings';
import { parseShareToken } from '../shared/share-url';
import { setupQueueView } from './queue-view';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- ログ ----------
function log(label: string, value?: unknown) {
  const time = new Date().toLocaleTimeString();
  const body = value === undefined ? '' : `\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
  const pre = $('log');
  pre.textContent = `[${time}] ${label}${body}\n\n${pre.textContent ?? ''}`.slice(0, 200_000);
}

const queueView = setupQueueView(log);
$('log-clear').addEventListener('click', () => ($('log').textContent = ''));

/** ボタンを押している間は無効にして、例外はログに出す */
function action(button: HTMLButtonElement, fn: () => Promise<void>) {
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
}

function makeButton(text: string, onClick: () => Promise<void>, className = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  action(b, onClick);
  return b;
}

function fillTable(tableId: string, rows: HTMLTableRowElement[]) {
  const table = $<HTMLTableElement>(tableId);
  const tbody = table.tBodies[0];
  tbody.replaceChildren(...rows);
  table.hidden = false;
}

function fileRow(name: string, size: string, buttons: HTMLButtonElement[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const tdName = document.createElement('td');
  tdName.textContent = name;
  const tdSize = document.createElement('td');
  tdSize.textContent = size;
  const tdActions = document.createElement('td');
  tdActions.className = 'actions';
  tdActions.append(...buttons);
  tr.append(tdName, tdSize, tdActions);
  return tr;
}

function listOf(data: any): any[] {
  return Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
}

// ---------- タブ ----------
const TABS = ['queue', 'log', 'settings', 'tools'];
function showTab() {
  const name = location.hash.slice(1);
  const tab = TABS.includes(name) ? name : 'queue';
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((p) => (p.hidden = p.dataset.page !== tab));
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((a) => {
    const active = a.dataset.tab === tab;
    a.classList.toggle('active', active);
    a.setAttribute('aria-selected', String(active));
  });
}
window.addEventListener('hashchange', showTab);
showTab();

// ---------- Linkex の状態 ----------
function setMeter(barId: string, used: number, total: number) {
  const ratio = total > 0 ? used / total : 0;
  const bar = $(barId);
  bar.style.width = `${Math.min(100, ratio * 100)}%`;
  bar.parentElement!.className = `meter${ratio >= 1 ? ' ng' : ratio >= 0.8 ? ' warn' : ''}`;
}

async function refreshLinkex() {
  try {
    const [usage, traffic] = await Promise.all([linkexApi.usage(), linkexApi.traffic()]);
    $('usage-text').textContent = `${formatBytes(usage.usedSpace)} / ${formatBytes(usage.totalSpace)}`;
    setMeter('usage-bar', usage.usedSpace, usage.totalSpace);
    const reset = traffic.resetTime ? new Date(traffic.resetTime * 1000).toLocaleString() : '-';
    $('traffic-text').textContent = `${formatBytes(traffic.usedTraffic)} / ${formatBytes(traffic.totalTraffic)}`;
    queueView.setTraffic(traffic);
    $('traffic-metric').title = `直近24時間の転送量（目安）。リセット ${reset}`;
    setMeter('traffic-bar', traffic.usedTraffic, traffic.totalTraffic);
  } catch (e) {
    $('usage-text').textContent = '取得できません';
    $('usage-text').title = (e as Error).message;
    $('traffic-text').textContent = '-';
    throw e;
  }
}
action($('linkex-refresh'), refreshLinkex);
action($('linkex-open'), async () => {
  const res = await send({ type: 'linkex.openTab' });
  if (!res.ok) throw new Error(res.error);
});

// ---------- Motrix ----------
action($('motrix-test'), async () => {
  const el = $('motrix-status');
  el.textContent = '確認中…';
  el.className = 'muted';
  // 入力中（未保存）の設定ではなく、保存済みの設定で試す
  const res = await send<{ version: string }>({ type: 'motrix.version' });
  if (res.ok) {
    el.textContent = `接続OK（aria2 ${res.data.version}）`;
    el.className = 'ok';
  } else {
    el.textContent = res.error;
    el.className = 'ng';
  }
});

// ---------- 設定 ----------
const form = $<HTMLFormElement>('settings');
async function loadSettingsIntoForm() {
  const res = await send<Settings>({ type: 'settings.get' });
  if (!res.ok) return log(`設定の読み込みに失敗: ${res.error}`);
  const s = res.data;
  (form.elements.namedItem('rpcUrl') as HTMLInputElement).value = s.rpcUrl;
  (form.elements.namedItem('rpcSecret') as HTMLInputElement).value = s.rpcSecret;
  (form.elements.namedItem('downloadDir') as HTMLInputElement).value = s.downloadDir;
  (form.elements.namedItem('apiIntervalMs') as HTMLInputElement).value = String(s.apiIntervalMs);
  (form.elements.namedItem('maxDownloads') as HTMLInputElement).value = String(s.maxDownloads);
  (form.elements.namedItem('pauseOnTrafficLimit') as HTMLInputElement).checked = s.pauseOnTrafficLimit;
  (form.elements.namedItem('notifications') as HTMLInputElement).checked = s.notifications;
  (form.elements.namedItem('autoStartOnAdd') as HTMLInputElement).checked = s.autoStartOnAdd;
}
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = (name: string) => (form.elements.namedItem(name) as HTMLInputElement);
  const patch: Partial<Settings> = {
    rpcUrl: v('rpcUrl').value.trim(),
    rpcSecret: v('rpcSecret').value,
    downloadDir: v('downloadDir').value.trim(),
    apiIntervalMs: Math.max(0, Number(v('apiIntervalMs').value) || 0),
    maxDownloads: Math.min(16, Math.max(1, Number(v('maxDownloads').value) || 1)),
    pauseOnTrafficLimit: v('pauseOnTrafficLimit').checked,
    notifications: v('notifications').checked,
    autoStartOnAdd: v('autoStartOnAdd').checked,
  };
  const res = await send({ type: 'settings.set', patch });
  $('settings-saved').textContent = res.ok ? '保存しました' : `保存に失敗: ${res.error}`;
  $('settings-saved').className = res.ok ? 'ok' : 'ng';
  setTimeout(() => ($('settings-saved').textContent = ''), 3000);
});

// ---------- 1. 共有リンクの中身 ----------
async function showShare(token: string, trail: { id?: string; name: string }[]) {
  const parentId = trail[trail.length - 1]?.id;
  const content = await linkexApi.shareContent(token, parentId);
  log(`共有の中身 ${token}${parentId ? ` / ${parentId}` : ''}`, content);
  $('share-path').textContent = trail.map((t) => t.name).join(' / ');

  const rows: HTMLTableRowElement[] = [];
  if (trail.length > 1) {
    rows.push(fileRow('..（上へ）', '', [makeButton('戻る', () => showShare(token, trail.slice(0, -1)))]));
  }
  for (const item of listOf(content)) {
    const f = unwrapFile(item);
    const id = String(f.id);
    if (isFolder(f)) {
      rows.push(fileRow(`📁 ${f.name}`, '', [makeButton('開く', () => showShare(token, [...trail, { id, name: f.name }]))]));
    } else {
      rows.push(fileRow(f.name, formatBytes(f.size), [makeButton('自分のストレージに保存', () => copyOne(token, id, f.name), 'primary')]));
    }
  }
  fillTable('share-table', rows);
}

action($('share-load'), async () => {
  const token = parseShareToken($<HTMLInputElement>('share-input').value);
  if (!token) throw new Error('共有URLの形式を読み取れませんでした');
  const info = await linkexApi.share(token);
  log(`共有情報 ${token}`, info);
  const name = info?.share?.name ?? info?.name ?? token;
  await showShare(token, [{ name }]);
});

async function copyOne(token: string, fileId: string, name: string) {
  log(`保存を開始: ${name}`);
  const result = await linkexApi.copyFromShare(token, fileId);
  log('file/copy の応答', result);
  const taskId = result?.taskId;
  if (!taskId) {
    log('taskId がないため、完了待ちはしません');
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    await new Promise((r) => setTimeout(r, 1000));
    const task = await linkexApi.task(String(taskId));
    const t = task?.task ?? task;
    const status = String(t?.status ?? '').toLowerCase();
    if (status === 'success') {
      log(`保存が完了: ${name}`, task);
      await loadMine();
      return;
    }
    if (status && !['pending', 'running', 'processing', 'waiting', 'queued', 'init'].includes(status)) {
      log(`保存が失敗または想定外の状態: ${status}`, task);
      return;
    }
  }
  log('保存の完了を2分待ちましたが終わりませんでした');
}

// ---------- 2. 自分のファイル ----------
interface IssuedUrl { fileId: string; name: string; url: string; issuedAt: number; result: string }
const issuedUrls: IssuedUrl[] = [];

async function loadMine() {
  const data = await linkexApi.myFiles();
  log('自分のファイル', data);
  const rows = listOf(data).map((item) => {
    const f = unwrapFile(item);
    const id = String(f.id);
    if (isFolder(f)) return fileRow(`📁 ${f.name}`, '', []);
    return fileRow(f.name, formatBytes(f.size), [
      makeButton('URL取得', async () => {
        await issueUrl(id, f.name);
      }),
      makeButton('Motrixへ送る', () => sendToMotrix(id, f.name), 'primary'),
      makeButton('ゴミ箱へ', async () => {
        log('ゴミ箱へ移動', await linkexApi.moveToTrash(id));
        await loadMine();
        await loadTrash();
      }),
    ]);
  });
  fillTable('mine-table', rows);
}
action($('mine-load'), loadMine);

async function issueUrl(fileId: string, name: string): Promise<string> {
  const data = await linkexApi.fileGet(fileId);
  const url = String(data?.file?.url ?? data?.url ?? '');
  if (!url) throw new Error('ダウンロードURLが応答に含まれていません');
  issuedUrls.unshift({ fileId, name, url, issuedAt: Date.now(), result: '-' });
  renderUrls();
  log(`URLを発行: ${name}`, url);
  return url;
}

async function sendToMotrix(fileId: string, name: string) {
  const url = await issueUrl(fileId, name);
  const res = await send<string>({ type: 'motrix.add', url, out: name });
  if (!res.ok) throw new Error(res.error);
  log(`Motrixに追加しました: ${name}（GID ${res.data}）`);
}

function renderUrls() {
  const rows = issuedUrls.map((u) => {
    const tr = document.createElement('tr');
    const age = Math.round((Date.now() - u.issuedAt) / 1000);
    tr.innerHTML = '<td></td><td></td><td></td><td class="actions"></td>';
    tr.cells[0].textContent = u.name;
    tr.cells[1].textContent = `${new Date(u.issuedAt).toLocaleTimeString()}（${age}秒前）`;
    tr.cells[2].textContent = u.result;
    tr.cells[3].append(
      makeButton('まだ使えるか確認', async () => {
        const res = await send<{ status: number; contentRange: string | null }>({ type: 'cdn.probe', url: u.url });
        const elapsed = Math.round((Date.now() - u.issuedAt) / 1000);
        u.result = res.ok ? `HTTP ${res.data.status}（発行から${elapsed}秒）` : `失敗: ${res.error}`;
        log(`URL確認: ${u.name}`, u.result);
        renderUrls();
      }),
    );
    return tr;
  });
  fillTable('urls-table', rows);
}

// ---------- 3. ゴミ箱 ----------
async function loadTrash() {
  const data = await linkexApi.trashList();
  log('ゴミ箱', data);
  const rows = listOf(data).map((item) => {
    const f = unwrapFile(item);
    const id = String(f.id);
    return fileRow(f.name, formatBytes(f.size), [
      makeButton('元に戻す', async () => {
        log('元に戻す', await linkexApi.restore(id));
        await loadTrash();
        await loadMine();
      }),
      makeButton('完全削除', async () => {
        if (!confirm(`「${f.name}」を完全に削除します。取り消せません。よろしいですか？`)) return;
        log(`完全削除: ${f.name}`, await linkexApi.deleteForever(id));
        await loadTrash();
        await refreshLinkex();
      }, 'danger'),
    ]);
  });
  fillTable('trash-table', rows);
}
action($('trash-load'), loadTrash);

// ---------- 起動時 ----------
void loadSettingsIntoForm();
const refreshQuietly = () =>
  refreshLinkex().catch((e) => log(`Linkexの状態を取得できませんでした: ${(e as Error).message}`));
void refreshQuietly();
// 容量・転送量は1分ごとに取り直す（画面が見えているときだけ）
setInterval(() => {
  if (document.visibilityState === 'visible') void refreshQuietly();
}, 60_000);
