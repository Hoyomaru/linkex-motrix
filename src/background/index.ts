import type { MotrixLive, Request, Response } from '../shared/messages';
import { ACTIVE_STATES, FINISHED_STATES, type QueueItem } from '../shared/queue';
import { loadSettings, saveSettings } from '../shared/settings';
import { kick, pause, refreshDownloads, start } from './engine';
import { addWalkedToQueue, enqueueShares } from './enqueue';
import { callLinkex, ensureLinkexTab, walkShareInTab } from './linkex-tab';
import { addDownload, getGlobalStat, getVersion, tellActive, tellStatus } from './motrix';
import { clearEvents, clearHashes, mutateQueue, readEngine } from './store';
import { watchBadge } from './badge';
import { createMenus, setupMenuClicks } from './menus';
import { setupNotificationClick } from './notify';

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  handle(message, sender.tab?.id)
    .then((data) => sendResponse({ ok: true, data } satisfies Response))
    .catch((e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) } satisfies Response));
  return true; // 非同期で応答する
});

// Service Worker が止められても、1分ごとに起きて続きを再開する
chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'tick') return;
  const engine = await readEngine();
  if (!engine.paused) kick();
  else await refreshDownloads().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(resumeIfRunning);

// ツールバーの残り件数・右クリックメニュー・通知のクリック
watchBadge();
setupMenuClicks();
setupNotificationClick(() => openDashboard());
chrome.runtime.onInstalled.addListener(async () => {
  // 0.1.0 で「Motrixに見つからない」とエラーにしていた件は、実際には完了していたので直す
  await mutateQueue((items) => {
    for (const item of items) {
      if (item.state === 'error' && item.error?.startsWith('Motrixにこのダウンロードが見つかりません')) {
        Object.assign(item, { state: 'done', error: undefined, gid: undefined, note: 'Motrixの履歴になし', updatedAt: Date.now() });
      }
    }
  });
  createMenus();
  await resumeIfRunning();
});

/** 専用ページを開く。すでに開いていればそのタブを前に出す */
async function openDashboard(tab?: string): Promise<true> {
  const base = chrome.runtime.getURL('dashboard.html');
  const url = tab ? `${base}#${tab}` : undefined;
  // タブを切り替えた後は末尾に #log などが付くので、前方一致で探す
  const existing = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, url ? { active: true, url } : { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url ?? base });
  }
  return true;
}

async function resumeIfRunning() {
  const engine = await readEngine();
  if (!engine.paused) kick();
}

/** pageTabId: 頼んできたタブ（共有ページのパネルから頼まれたとき、そのページの中で共有を読むのに使う） */
async function handle(req: Request, pageTabId?: number): Promise<unknown> {
  switch (req.type) {
    case 'linkex.call': {
      const result = await callLinkex({ method: req.method, path: req.path, params: req.params, data: req.data });
      if (!result.ok) {
        throw new Error(`${result.error}${result.detail ? ` ${JSON.stringify(result.detail)}` : ''}`);
      }
      return result.data;
    }
    case 'linkex.openTab': {
      const tabId = await ensureLinkexTab();
      await chrome.tabs.update(tabId, { active: true });
      return tabId;
    }
    case 'motrix.version':
      return getVersion();
    case 'motrix.add':
      return addDownload(req.url, { dir: req.dir, out: req.out });
    case 'motrix.status':
      return tellStatus(req.gid);
    case 'motrix.active': {
      const [active, stat] = await Promise.all([tellActive(), getGlobalStat()]);
      return {
        downloadSpeed: Number(stat.downloadSpeed) || 0,
        active: active.map((a) => ({
          gid: a.gid,
          totalLength: Number(a.totalLength) || 0,
          completedLength: Number(a.completedLength) || 0,
          downloadSpeed: Number(a.downloadSpeed) || 0,
        })),
      } satisfies MotrixLive;
    }
    case 'cdn.probe':
      return probeCdn(req.url);

    case 'queue.add':
      return enqueueShares(req.text, pageTabId);
    case 'share.walk': {
      const res = await walkShareInTab(req.token, { pageTabId });
      if (!res.ok) throw new Error(res.error);
      return { shareName: res.shareName, files: res.files };
    }
    case 'queue.addFiles':
      return addWalkedToQueue([{ token: req.token, shareName: req.shareName, files: req.files, collapseRoot: req.collapseRoot }]);
    case 'dashboard.open':
      return openDashboard(req.tab);
    case 'queue.start':
      return start();
    case 'queue.pause':
      return pause();
    case 'queue.retry':
      return mutateQueue((items) => {
        const item = items.find((i) => i.id === req.id);
        if (item) retryItem(item);
      });
    case 'queue.retryFailed':
      return mutateQueue((items) => {
        let n = 0;
        for (const item of items) {
          if (item.state === 'error' && (!req.token || item.shareToken === req.token) && retryItem(item)) n++;
        }
        return n;
      });
    case 'queue.remove':
      return mutateQueue((items) => removeItems(items, new Set([req.id])));
    case 'queue.removeMany':
      return mutateQueue((items) => removeItems(items, new Set(req.ids)));
    case 'queue.clearFinished':
      return mutateQueue((items) => {
        const keep = items.filter((i) => !FINISHED_STATES.includes(i.state));
        items.splice(0, items.length, ...keep);
      });

    case 'events.clear':
      return clearEvents();
    case 'hashes.clear':
      return clearHashes();
    case 'settings.get':
      return loadSettings();
    case 'settings.set':
      return saveSettings(req.patch);
  }
}

/** 失敗・省略した件を、もう一度最初からやり直す状態に戻す */
function retryItem(item: QueueItem): boolean {
  if (item.state !== 'error' && item.state !== 'skipped') return false;
  // 「重複のため省略」を落とし直す場合は、重複判定を外す
  const force = item.state === 'skipped' || item.force;
  Object.assign(item, { state: 'retry', attempts: 0, error: undefined, note: undefined, force, updatedAt: Date.now() });
  return true;
}

/** 一覧から消す。保存中・削除中の件は、ストレージにコピーが残らないよう消させない */
function removeItems(items: QueueItem[], ids: Set<string>): number {
  const keep = items.filter((i) => !ids.has(i.id) || ACTIVE_STATES.includes(i.state));
  const removed = items.length - keep.length;
  items.splice(0, items.length, ...keep);
  return removed;
}

/** ダウンロードURLがまだ使えるかを、先頭1バイトだけ取得して確かめる */
async function probeCdn(url: string): Promise<{ status: number; contentRange: string | null }> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status, contentRange: res.headers.get('content-range') };
}
