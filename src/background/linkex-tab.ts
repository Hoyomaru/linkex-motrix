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
/** 記録に残すページの場所（クエリなどは付けない） */
const pagePath = (url: string | undefined) => {
  try {
    const u = new URL(url ?? '');
    return `${u.host}${u.pathname}`;
  } catch {
    return '不明なページ';
  }
};
const isLinkex = (url: string | undefined) => !!url && /^https:\/\/(www\.)?linkex\.io\//.test(url);

/** Linkexのログインが切れている。件ごとの失敗ではなく、全体を止める理由になる */
export class LinkexLoginError extends Error {
  /** reason: 何が失敗してログイン切れと判断したか（後から調べられるよう、メッセージに添える） */
  constructor(reason?: string) {
    super(`Linkexのログインが切れています。固定タブでログインし直してから「開始」を押してください${reason ? `（${reason}）` : ''}`);
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

/** 読み込み直している最中のタブ。同時に呼んでいる複数の件が、それぞれ読み込み直さないようにする */
const reloading = new Map<number, Promise<void>>();
/** タブを読み込み直すたびに増える。呼び出しの途中で読み込み直されたかを見分けるのに使う */
let reloadEpoch = 0;

function reloadAndWait(tabId: number): Promise<void> {
  const current = reloading.get(tabId);
  if (current) return current;
  reloadEpoch++;
  const run = (async () => {
    await chrome.tabs.reload(tabId);
    // 読み込みが始まる前に「complete」を拾わないよう、いったん読み込み中になるのを待つ
    for (let i = 0; i < 10; i++) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') break;
      await sleep(100);
    }
    await waitForComplete(tabId);
  })().finally(() => reloading.delete(tabId));
  reloading.set(tabId, run);
  return run;
}

/**
 * Linkex Web版ドライブの固定タブを用意する。
 * すでに開いていればそれを使い、なければ裏で固定タブとして開く。
 * メモリ不足で破棄されないよう autoDiscardable を切る。
 */
let cachedTabId: number | null = null;
/** タブを探している・開いている最中なら、その結果を待って使う（同時に呼ばれてタブが増えないように） */
let ensuring: Promise<number> | null = null;

export async function ensureLinkexTab(): Promise<number> {
  // ほかの件が読み込み直している最中なら、終わるのを待つ
  if (cachedTabId !== null) await reloading.get(cachedTabId)?.catch(() => undefined);
  // 前回使ったタブがそのまま使えるなら、確認を最小限にして返す
  if (cachedTabId !== null) {
    const tab = await chrome.tabs.get(cachedTabId).catch(() => undefined);
    if (tab?.id !== undefined && isDrive(tab.url) && tab.status === 'complete') {
      if (await wakeIfAsleep(tab)) {
        const woke = await chrome.tabs.get(tab.id);
        if (!isDrive(woke.url)) throw new LinkexLoginError(`タブが ${pagePath(woke.url)} に移りました`);
      }
      return tab.id;
    }
    cachedTabId = null;
  }
  ensuring ??= findOrOpenTab().finally(() => (ensuring = null));
  return ensuring;
}

async function findOrOpenTab(): Promise<number> {
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
  if (!isDrive(loaded.url)) throw new LinkexLoginError(`タブが ${pagePath(loaded.url)} に移りました`);
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

// API呼び出しは同時に「同時に処理する数」本まで流す。始める間隔は設定どおりに空ける
let startGate: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
let activeCalls = 0;
const callWaiters: (() => void)[] = [];

export function callLinkex(req: BridgeRequest): Promise<BridgeResult> {
  // 始める順番は頼まれた順。空きができるまで、後の呼び出しも並んで待つ
  const begin = async () => {
    const { apiIntervalMs, parallelItems } = await loadSettings();
    while (activeCalls >= Math.max(1, parallelItems)) await new Promise<void>((r) => callWaiters.push(r));
    const wait = lastCallAt + apiIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    activeCalls++;
  };
  const gate = startGate.then(begin, begin);
  startGate = gate.catch(() => undefined);
  return gate.then(async () => {
    try {
      return await run();
    } finally {
      activeCalls--;
      callWaiters.shift()?.();
    }
  });

  async function run(): Promise<BridgeResult> {
    const tabId = await ensureLinkexTab();
    const startedAt = Date.now();
    let result = await execute(tabId, req);
    // ページの部品がまだ読み込まれていない場合は少し待って1回だけやり直す
    if (!result.ok && result.error === 'index_not_found') {
      await sleep(1500);
      result = await execute(tabId, req);
    }
    // 遅い呼び出しは、どこで時間がかかっているかを後から調べられるよう記録する
    const elapsed = Date.now() - startedAt;
    if (elapsed >= SLOW_CALL_MS) {
      void logEvent('warn', `Linkexの応答が遅い: ${req.path}・${(elapsed / 1000).toFixed(1)}秒${result.ok ? '' : `（${result.error}）`}`);
    }
    return result;
  }
}

/** API呼び出し1回の待ち時間の上限 */
const CALL_TIMEOUT_MS = 20_000;
/** これより時間がかかった呼び出しは処理ログに残す */
const SLOW_CALL_MS = 3_000;

/**
 * 応答がないときのタブの様子を調べる（原因を見分けるための記録用）。
 * タブが命令に応じるか、頼んだ通信がページから送られて返ってきているかを見る
 */
async function diagnoseStall(tabId: number, req: BridgeRequest, since: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const flags = [
    tab?.frozen ? '凍結' : '',
    tab?.discarded ? '破棄' : '',
    tab?.status !== 'complete' ? `読み込み中(${tab?.status})` : '',
    tab?.active ? '表示中' : '裏',
  ].filter(Boolean).join('・');
  try {
    const [injection] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (path: string, sinceMs: number) => {
          // 頼んだ時刻より後に、その通信が返ってきた記録があるか
          const origin = performance.timeOrigin;
          const done = performance
            .getEntriesByType('resource')
            .filter((e) => e.name.includes(path) && origin + e.startTime >= sinceMs - 1000)
            .map((e) => Math.round((e as PerformanceResourceTiming).duration));
          return { done, visible: document.visibilityState };
        },
        args: [req.path, since],
      }),
      3_000,
    );
    const r = injection?.result as { done: number[]; visible: string } | undefined;
    const net = r?.done.length ? `通信は返っている(${r.done.join(',')}ms)` : '通信は返っていない';
    return `タブは応答する・${net}・${r?.visible ?? '?'}・${flags}`;
  } catch {
    return `タブも応答しない・${flags}`;
  }
}

/**
 * タブの中でAPIを1回呼ぶ。途中でタブが凍結されたら、すぐ読み込み直してやり直す。
 * 凍結以外の理由で返事がないときは、様子を記録して1回だけ読み込み直す。
 */
async function execute(tabId: number, req: BridgeRequest): Promise<BridgeResult> {
  const once = async () => {
    const frozen = watchFrozen(tabId);
    try {
      const [injection] = await Promise.race([
        withTimeout(
          chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: linkexBridgeCall, args: [req] }),
          CALL_TIMEOUT_MS,
        ),
        frozen.promise,
      ]);
      return (injection?.result as BridgeResult | undefined) ?? { ok: false as const, error: 'no_result' };
    } finally {
      frozen.stop();
    }
  };
  let timeouts = 0;
  for (let attempt = 1; ; attempt++) {
    const since = Date.now();
    const epoch = reloadEpoch;
    try {
      const result = await once();
      // 途中でほかの件がタブを読み込み直すと、空の返事になることがある。読み込みを待ってやり直す
      if (!result.ok && result.error === 'no_result' && reloadEpoch !== epoch && attempt < MAX_FROZEN_RELOADS) {
        await reloading.get(tabId)?.catch(() => undefined);
        continue;
      }
      return result;
    } catch (e) {
      if (!(e instanceof TabTimeoutError) && !(e instanceof TabFrozenError)) {
        // 同時に動いているほかの件がタブを読み込み直すと、こちらの命令は途中で失敗する。読み込みを待ってやり直す
        if (reloadEpoch === epoch || attempt >= MAX_FROZEN_RELOADS) throw e;
        await reloading.get(tabId)?.catch(() => undefined);
        continue;
      }
      if (e instanceof TabTimeoutError) {
        // 凍結とは別の理由で返事がない。様子を記録してから読み込み直す（これは1回まで）
        if (++timeouts > 1) {
          throw new Error('Linkexのタブが応答しません。Linkexのタブを一度開いてから、もう一度「開始」を押してください');
        }
        const why = await diagnoseStall(tabId, req, since);
        void logEvent('warn', `Linkexのタブが応答しないため、読み込み直します: ${req.path}（${why}）`);
      }
      // Edgeは裏のタブを数秒で凍結することがあり、よく起きるので1回ずつは書かず、回数だけ数える
      if (e instanceof TabFrozenError && !reloading.has(tabId)) frozenReloads++;
      if (attempt >= MAX_FROZEN_RELOADS) {
        throw new Error('Linkexのタブがすぐに凍結されてしまいます。Linkexのタブを一度表示してから、もう一度「開始」を押してください');
      }
      await reloadAndWait(tabId);
    }
  }
}

let frozenReloads = 0;
/** 凍結されたタブを読み込み直した回数を返し、数え直す */
export function takeFrozenReloads(): number {
  const n = frozenReloads;
  frozenReloads = 0;
  return n;
}

/** 1回の呼び出しの中で、凍結されたタブを読み込み直す回数の上限 */
const MAX_FROZEN_RELOADS = 4;
/** 凍結されていないかを見る間隔 */
const FROZEN_POLL_MS = 250;

/** Edgeに凍結・破棄されたタブには、命令しても返事が来ない */
class TabFrozenError extends Error {}

/**
 * 呼び出しの最中にタブが凍結・破棄されたら、すぐ失敗にする。
 * これがないと、返事の待ちの上限（20秒）まで待ってしまう
 */
function watchFrozen(tabId: number): { promise: Promise<never>; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setInterval(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.frozen || tab?.discarded) reject(new TabFrozenError('frozen'));
    }, FROZEN_POLL_MS);
  });
  promise.catch(() => undefined); // 止めた後に失敗しても、未処理のエラーにしない
  return { promise, stop: () => clearInterval(timer) };
}
