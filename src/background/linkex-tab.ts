import {
  linkexBridgeCall,
  linkexBridgeWalkShare,
  type BridgeRequest,
  type BridgeResult,
  type WalkResult,
} from './linkex-bridge';
import { loadSettings } from '../shared/settings';

const DRIVE_URL = 'https://www.linkex.io/drive/all';
const DRIVE_PATTERN = 'https://www.linkex.io/drive/*';
const TAB_KEY = 'linkexTabId';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isDrive = (url: string | undefined) => !!url?.startsWith('https://www.linkex.io/drive/');
const isLinkex = (url: string | undefined) => !!url && /^https:\/\/(www\.)?linkex\.io\//.test(url);

/** Linkexのログインが切れている。件ごとの失敗ではなく、全体を止める理由になる */
export class LinkexLoginError extends Error {
  constructor() {
    super('Linkexのログインが切れています。固定タブでログインし直してから「開始」を押してください');
  }
}

async function waitForComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(300);
  }
  throw new Error('Linkexのページの読み込みが終わりませんでした');
}

/**
 * Linkex Web版ドライブの固定タブを用意する。
 * すでに開いていればそれを使い、なければ裏で固定タブとして開く。
 * メモリ不足で破棄されないよう autoDiscardable を切る。
 */
let cachedTabId: number | null = null;

export async function ensureLinkexTab(): Promise<number> {
  // 前回使ったタブがそのまま使えるなら、確認を最小限にして返す
  if (cachedTabId !== null) {
    const tab = await chrome.tabs.get(cachedTabId).catch(() => undefined);
    if (tab?.id !== undefined && isDrive(tab.url) && tab.status === 'complete') {
      return tab.id;
    }
    cachedTabId = null;
  }
  const saved = (await chrome.storage.session.get(TAB_KEY))[TAB_KEY] as number | undefined;
  let tab: chrome.tabs.Tab | undefined;

  if (saved !== undefined) {
    tab = await chrome.tabs.get(saved).catch(() => undefined);
    // 自分の固定タブがLinkexの別のページ（ログイン画面など）にいる場合は、
    // 新しいタブを増やさず、ドライブに戻してみる
    if (tab?.id !== undefined && !isDrive(tab.url)) {
      if (isLinkex(tab.url) || isLinkex(tab.pendingUrl)) {
        tab = await chrome.tabs.update(tab.id, { url: DRIVE_URL });
      } else {
        tab = undefined;
      }
    }
  }
  if (!tab) {
    const found = await chrome.tabs.query({ url: DRIVE_PATTERN });
    tab = found.find((t) => t.pinned) ?? found[0];
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: DRIVE_URL, pinned: true, active: false });
  }
  if (tab.id === undefined) throw new Error('Linkexのタブを開けませんでした');

  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  await chrome.storage.session.set({ [TAB_KEY]: tab.id });
  await waitForComplete(tab.id);
  // ドライブを開いたのにログイン画面などへ移された場合は、ログインが切れている
  const loaded = await chrome.tabs.get(tab.id);
  if (!isDrive(loaded.url)) throw new LinkexLoginError();
  cachedTabId = tab.id;
  return tab.id;
}

/** 共有の中身をページ内で一括して読む。処理用の順番待ちには並ばない */
export async function walkShareInTab(token: string, concurrency = 4): Promise<WalkResult> {
  const tabId = await ensureLinkexTab();
  const run = async () => {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: linkexBridgeWalkShare,
      args: [token, concurrency],
    });
    return (injection?.result as WalkResult | undefined) ?? { ok: false as const, error: 'no_result' };
  };
  let result = await run();
  if (!result.ok && result.error === 'index_not_found') {
    await sleep(1500);
    result = await run();
  }
  return result;
}

// API呼び出しを1本ずつ、設定した間隔を空けて流す
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

export function callLinkex(req: BridgeRequest): Promise<BridgeResult> {
  const run = async (): Promise<BridgeResult> => {
    const { apiIntervalMs } = await loadSettings();
    const wait = lastCallAt + apiIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    const tabId = await ensureLinkexTab();
    let result = await execute(tabId, req);
    // ページの部品がまだ読み込まれていない場合は少し待って1回だけやり直す
    if (!result.ok && result.error === 'index_not_found') {
      await sleep(1500);
      result = await execute(tabId, req);
    }
    return result;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

async function execute(tabId: number, req: BridgeRequest): Promise<BridgeResult> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: linkexBridgeCall,
    args: [req],
  });
  return (injection?.result as BridgeResult | undefined) ?? { ok: false, error: 'no_result' };
}
