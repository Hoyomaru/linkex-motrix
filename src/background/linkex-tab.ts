import {
  linkexBridgeCall,
  linkexBridgeWalkShare,
  type BridgeRequest,
  type BridgeResult,
  type WalkResult,
} from './linkex-bridge';
import { loadSettings } from '../shared/settings';
import { logEvent } from './store';

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

/** 時間内に終わらなければ失敗にする（凍結したタブへの命令は、起きるまで返ってこないため） */
class TabTimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TabTimeoutError('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Edgeの「スリープ中のタブ」などで凍結・破棄されたタブは、拡張機能からの命令を受け付けない。
 * そういうタブは読み込み直して起こす。起こしたら true
 */
async function wakeIfAsleep(tab: chrome.tabs.Tab): Promise<boolean> {
  if (tab.id === undefined || !(tab.frozen || tab.discarded)) return false;
  await reloadAndWait(tab.id);
  return true;
}

async function reloadAndWait(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId);
  // 読み込みが始まる前に「complete」を拾わないよう、いったん読み込み中になるのを待つ
  for (let i = 0; i < 10; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') break;
    await sleep(100);
  }
  await waitForComplete(tabId);
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
      if (await wakeIfAsleep(tab)) {
        const woke = await chrome.tabs.get(tab.id);
        if (!isDrive(woke.url)) throw new LinkexLoginError();
      }
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
  if (!(await wakeIfAsleep(tab))) await waitForComplete(tab.id);
  // ドライブを開いたのにログイン画面などへ移された場合は、ログインが切れている
  const loaded = await chrome.tabs.get(tab.id);
  if (!isDrive(loaded.url)) throw new LinkexLoginError();
  cachedTabId = tab.id;
  return tab.id;
}

/** 共有を読んでいる途中の件数。画面（共有ページのパネル）が storage を見て表示する */
export const WALK_PROGRESS_KEY = 'walkProgress';
export interface WalkProgress {
  /** tab: Linkexのタブを用意している / 省略: 読んでいる */
  phase?: 'tab';
  files: number;
  bytes: number;
  folders: number;
  at: number;
}

/** 読み終えた共有はしばらく覚えておき、「選んで追加」→「追加」などで読み直さない */
const WALK_CACHE_MS = 10 * 60_000;
const walkCache = new Map<string, { at: number; promise: Promise<WalkResult> }>();

/**
 * 共有の中身をページ内で一括して読む。処理用の順番待ちには並ばない。
 * 同じ共有を読んでいる最中に頼まれたら、その結果を待って使う。
 */
export function walkShareInTab(
  token: string,
  opts: { fresh?: boolean; pageTabId?: number } = {},
): Promise<WalkResult> {
  const cached = walkCache.get(token);
  if (cached && !opts.fresh && Date.now() - cached.at < WALK_CACHE_MS) return cached.promise;
  const promise = doWalk(token, opts.pageTabId).then((res) => {
    if (!res.ok) walkCache.delete(token); // 失敗は覚えない
    return res;
  });
  walkCache.set(token, { at: Date.now(), promise });
  for (const [key, entry] of walkCache) {
    if (Date.now() - entry.at > WALK_CACHE_MS) walkCache.delete(key);
  }
  return promise;
}

const isSharePage = (url: string | undefined) =>
  !!url && /^https:\/\/(www\.)?(linkex\.io\/f|l2e\.click\/d)\//.test(url);

/**
 * 共有の中身を読む。頼んできたのが共有ページなら、まずそのページの中で読む
 * （共有の中身はログインなしで読めるので、裏のドライブのタブを用意して待たずに済む）。
 * だめならドライブの固定タブで読む。
 */
async function doWalk(token: string, pageTabId?: number, concurrency = 6): Promise<WalkResult> {
  const startedAt = Date.now();
  const state = { finished: false };
  let where = '共有ページ';
  try {
    let result: WalkResult | null = null;
    if (pageTabId !== undefined) {
      const tab = await chrome.tabs.get(pageTabId).catch(() => undefined);
      if (isSharePage(tab?.url)) result = await walkIn(pageTabId, token, concurrency, state);
    }
    if (!result?.ok) {
      where = 'Linkexのタブ';
      await setProgress(token, { phase: 'tab', files: 0, bytes: 0, folders: 0, at: Date.now() });
      const tabId = await ensureLinkexTab();
      result = await walkIn(tabId, token, concurrency, state);
      if (!result.ok && result.error === 'index_not_found') {
        await sleep(1500);
        result = await walkIn(tabId, token, concurrency, state);
      }
    }
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (result.ok) {
      const folders = new Set(result.files.map((f) => f.folders.join('/'))).size;
      void logEvent(
        'info',
        `共有を読み込み: ${result.files.length}件・フォルダ ${folders}・通信 ${result.requests}回・${sec}秒（${where}で）`,
      );
    }
    return result;
  } finally {
    state.finished = true;
    await setProgress(token, null);
  }
}

/** 指定したタブの中で共有をたどる。そのあいだ、途中経過を拾って storage に書く */
/** ページから20秒以上返事がなければ、凍結などで止まっているとみなす */
const WALK_STALL_MS = 20_000;

async function walkIn(tabId: number, token: string, concurrency: number, state: { finished: boolean }): Promise<WalkResult> {
  let lastAlive = Date.now();
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  const timer = setInterval(async () => {
    if (await relayProgress(tabId, token, state)) lastAlive = Date.now();
  }, 700);
  try {
    const stalled = new Promise<WalkResult>((resolve) => {
      stallTimer = setInterval(() => {
        if (Date.now() - lastAlive > WALK_STALL_MS) resolve({ ok: false, error: 'tab_unresponsive' });
      }, 1000);
    });
    const run = chrome.scripting
      .executeScript({ target: { tabId }, world: 'MAIN', func: linkexBridgeWalkShare, args: [token, concurrency] })
      .then(([injection]) => (injection?.result as WalkResult | undefined) ?? { ok: false as const, error: 'no_result' });
    return await Promise.race([run, stalled]);
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  } finally {
    clearInterval(timer);
    clearInterval(stallTimer);
  }
}

/** ページの途中経過を拾う。ページが返事をしたら true */
async function relayProgress(tabId: number, token: string, state: { finished: boolean }): Promise<boolean> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (t: string) => {
        const p = (window as any).__linkexMotrixWalkProgress?.[t];
        return p && !p.done ? { files: p.files, bytes: p.bytes, folders: p.folders } : null;
      },
      args: [token],
    });
    const p = injection?.result as Omit<WalkProgress, 'at' | 'phase'> | null | undefined;
    // 読み終わった後に古い途中経過を書き戻さない
    if (p && !state.finished) await setProgress(token, { ...p, at: Date.now() });
    return true;
  } catch {
    // 途中経過は出せなくても構わない
    return false;
  }
}

let progressWrite: Promise<unknown> = Promise.resolve();
function setProgress(token: string, value: WalkProgress | null): Promise<void> {
  const next = progressWrite.then(async () => {
    const all = ((await chrome.storage.local.get(WALK_PROGRESS_KEY))[WALK_PROGRESS_KEY] ?? {}) as Record<string, WalkProgress>;
    if (value) all[token] = value;
    else delete all[token];
    await chrome.storage.local.set({ [WALK_PROGRESS_KEY]: all });
  });
  progressWrite = next.catch(() => undefined);
  return next;
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

/** API呼び出し1回の待ち時間の上限 */
const CALL_TIMEOUT_MS = 20_000;

/**
 * タブの中でAPIを1回呼ぶ。返事がなければ（タブが凍結しているなど）タブを読み込み直して1回だけやり直す。
 */
async function execute(tabId: number, req: BridgeRequest): Promise<BridgeResult> {
  const once = async () => {
    const [injection] = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: linkexBridgeCall, args: [req] }),
      CALL_TIMEOUT_MS,
    );
    return (injection?.result as BridgeResult | undefined) ?? { ok: false as const, error: 'no_result' };
  };
  try {
    return await once();
  } catch (e) {
    if (!(e instanceof TabTimeoutError)) throw e;
    void logEvent('warn', 'Linkexのタブが応答しないため、読み込み直します（スリープ中のタブの可能性）');
    await reloadAndWait(tabId);
    try {
      return await once();
    } catch (e2) {
      if (e2 instanceof TabTimeoutError) {
        throw new Error('Linkexのタブが応答しません。Linkexのタブを一度開いてから、もう一度「開始」を押してください');
      }
      throw e2;
    }
  }
}
