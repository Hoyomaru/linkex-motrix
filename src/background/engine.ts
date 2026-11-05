import { contentHash, formatBytes, unwrapFile } from '../shared/files';
import type { QueueItem } from '../shared/queue';
import { findOwnCopy, PREP_STATES, pickStarts } from '../shared/scheduler';
import { loadSettings } from '../shared/settings';
import { api, collectPages, DISK_SPACE_FULL, LinkexError } from './api';
import { LinkexLoginError, takeFrozenReloads } from './linkex-tab';
import { addDownload, tellStatus, tellStopped, type Aria2Status } from './motrix';
import { notify } from './notify';
import { logEvent, readEngine, readHashes, readQueue, rememberHash, updateItem, updateItems, writeEngine } from './store';

const MAX_ATTEMPTS = 3;
const COPY_TIMEOUT_MS = 5 * 60_000;
/** 保存が終わってから、コピーが一覧に出てくるのを待つ時間 */
const COPY_FIND_MS = 60_000;
/** ダウンロードの空き待ち。Motrixへの確認はPCの中で済み軽いので、短めに見る */
const IDLE_WAIT_MS = 1_000;
const TRAFFIC_RECHECK_MS = 5 * 60_000;
const CAPACITY_WAIT_MS = 30_000;
const TRAFFIC_WAIT_MESSAGE = '転送量の上限に達したため待機中（設定で変更できます）';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (e: unknown) => String((e as Error)?.message ?? e);

/** 保存中のコピーの合計の上限（Linkexの容量の空きがこれより少なければ、空きのほうに合わせる） */
const STORAGE_CAP_BYTES = 5 * 1024 ** 3;
/** 空き容量を調べ直す間隔 */
const BUDGET_REFRESH_MS = 5 * 60_000;

let loopRunning = false;
/** 保存〜削除を進めている件（ID → 担当が終わるまでの Promise） */
const workers = new Map<string, Promise<void>>();
/** この時刻までは新しい件を始めない（容量不足と言われた後・転送量の上限） */
let capacityWaitUntil = 0;
let trafficWaitUntil = 0;
/** 保存中のコピーに使ってよい容量（バイト） */
let budget: { bytes: number; at: number } | null = null;

/** キューを処理するループを起動する（すでに動いていれば何もしない） */
export function kick(): void {
  if (loopRunning) return;
  loopRunning = true;
  let failed = false;
  runLoop()
    .catch(async (e) => {
      failed = true;
      await writeEngine({ message: `処理が止まりました: ${errorText(e)}` });
    })
    .finally(async () => {
      loopRunning = false;
      // ループが終わる直前に「開始」が押されていたら、ここで動かし直す
      // （失敗で止まったときは、すぐに繰り返さず1分ごとの見回りに任せる）
      if (!failed && !(await readEngine()).paused) kick();
    });
}

export async function start(): Promise<void> {
  await writeEngine({ paused: false, message: '開始しました' });
  takeFrozenReloads(); // 前回までの分は数えない
  capacityWaitUntil = 0;
  trafficWaitUntil = 0;
  budget = null;
  await logEvent('info', '処理を開始しました');
  kick();
}

export async function pause(): Promise<void> {
  // 処理中の件は、それぞれ区切りのよいところまで進めてから止まる
  await writeEngine({ paused: true, message: '一時停止中' });
  await logEvent('info', '一時停止しました');
}

/**
 * 全体の指示役。空きがあれば次の件に担当を付けて保存〜削除を並行して進め、
 * Motrixの完了を取り込み、全部終わったら知らせる。
 */
async function runLoop(): Promise<void> {
  while (true) {
    const engine = await readEngine();
    if (engine.paused) {
      // 動いている担当が区切りのよいところで止まるのを待つ
      await Promise.allSettled(workers.values());
      return;
    }

    const settings = await loadSettings();
    await refreshDownloads();
    const items = await readQueue();
    const downloading = items.filter((i) => i.state === 'downloading').length;
    const prep = items.filter((i) => PREP_STATES.includes(i.state));
    const waiting = items.filter((i) => i.state === 'pending' || i.state === 'retry');

    if (workers.size === 0 && prep.length === 0 && waiting.length === 0 && downloading === 0) {
      await finish(items);
      return;
    }

    // 保存中のコピーに使ってよい容量。コピーを置いていないときに調べ直す（置いている間は二重に数えてしまうため）
    if (!budget || (prep.length === 0 && Date.now() - budget.at > BUDGET_REFRESH_MS)) {
      budget = { bytes: await storageBudget(), at: Date.now() };
    }

    const ctx = {
      running: new Set(workers.keys()),
      parallel: Math.max(1, settings.parallelItems),
      budgetBytes: budget.bytes,
      maxDownloads: settings.maxDownloads,
    };
    let picks = pickStarts(items, { ...ctx, allowNew: Date.now() >= capacityWaitUntil && Date.now() >= trafficWaitUntil });
    const startsNew = picks.some((id) => waiting.some((w) => w.id === id));
    if (startsNew && settings.pauseOnTrafficLimit && (await trafficExhausted())) {
      // 待機中に Service Worker が止められると1分ごとの見回りでここに戻ってくるので、
      // ログは待機に入った最初の1回だけ書く
      if (engine.message !== TRAFFIC_WAIT_MESSAGE) {
        await logEvent('warn', '転送量の上限に達したため待機します（5分ごとに確認）');
      }
      trafficWaitUntil = Date.now() + TRAFFIC_RECHECK_MS;
      picks = pickStarts(items, { ...ctx, allowNew: false });
    }
    for (const id of picks) {
      workers.set(id, runWorker(id).finally(() => workers.delete(id)));
    }

    await writeEngine({ message: statusMessage(items, downloading, waiting.length, settings.maxDownloads) });
    // 担当が1つ終わったら、すぐ次の件を割り当てる
    await Promise.race([sleep(IDLE_WAIT_MS), ...workers.values()]);
  }
}

/** 画面上部に出す今の状況 */
function statusMessage(items: QueueItem[], downloading: number, waiting: number, maxDownloads: number): string {
  if (Date.now() < trafficWaitUntil && workers.size === 0) return TRAFFIC_WAIT_MESSAGE;
  const parts: string[] = [];
  if (workers.size > 0) {
    const first = items.find((i) => workers.has(i.id));
    parts.push(`処理中 ${workers.size}件（${first?.name ?? ''}${workers.size > 1 ? ' ほか' : ''}）`);
  }
  if (downloading > 0) {
    parts.push(`ダウンロード中 ${downloading}件${waiting > 0 && downloading >= maxDownloads ? '（空き待ち）' : ''}`);
  }
  if (Date.now() < capacityWaitUntil) parts.push('容量の空き待ち');
  return parts.join('・') || '待機中';
}

async function finish(items: QueueItem[]): Promise<void> {
  await writeEngine({ paused: true, message: 'すべて終わりました' });
  const frozen = takeFrozenReloads();
  await logEvent(
    'info',
    `キューの処理がすべて終わりました${frozen ? `（凍結されたLinkexのタブを読み込み直した回数 ${frozen}回）` : ''}`,
  );
  const done = items.filter((i) => i.state === 'done').length;
  const errors = items.filter((i) => i.state === 'error').length;
  await notify(
    'finished',
    errors ? `終わりました（失敗 ${errors}件）` : 'すべて終わりました',
    `完了 ${done}件${errors ? `・失敗 ${errors}件。専用ページで再試行できます` : ''}`,
  );
}

/** 保存中のコピーに使ってよい容量。5GBとLinkexの空き容量の小さいほう */
async function storageBudget(): Promise<number> {
  try {
    const usage = await api.usage();
    if (usage.totalSpace > 0) return Math.min(STORAGE_CAP_BYTES, Math.max(0, usage.totalSpace - usage.usedSpace));
  } catch {
    // 調べられなければ上限だけで進める（足りなければLinkexが容量不足と返す）
  }
  return STORAGE_CAP_BYTES;
}

/**
 * 1件の担当。保存 → コピー探し → URL発行・Motrixへ → 完全削除 まで進める。
 * 一時停止されたら区切りのよいところで止まる。失敗して待ちに戻ったら、割り当て直しを待つ
 */
async function runWorker(id: string): Promise<void> {
  for (let first = true; ; first = false) {
    if ((await readEngine()).paused) return;
    const item = (await readQueue()).find((i) => i.id === id);
    if (!item) return;
    const waitingState = item.state === 'pending' || item.state === 'retry';
    if (!PREP_STATES.includes(item.state) && !(first && waitingState)) return;
    await processItem(item);
  }
}

async function trafficExhausted(): Promise<boolean> {
  try {
    const t = await api.traffic();
    if (t.usedTraffic < 0) return false; // 上限なし扱いのアカウント
    return t.totalTraffic > 0 && t.usedTraffic >= t.totalTraffic;
  } catch {
    return false;
  }
}

/** 1件を1段階進める。失敗したら再試行待ちかエラーにする */
async function processItem(item: QueueItem): Promise<void> {
  try {
    switch (item.state) {
      case 'pending':
      case 'retry':
        await stepCopy(item);
        break;
      case 'copying':
        await stepFindCopy(item);
        break;
      case 'copied':
        await stepSend(item);
        break;
      case 'deleting':
        await stepDelete(item);
        break;
    }
  } catch (e) {
    if (e instanceof LinkexError && e.code === DISK_SPACE_FULL) {
      // 容量の確認は毎回はせず、足りないと言われたときだけ行う。
      // 容量の上限そのものより大きいファイルは、待っても保存できないので失敗にする
      if (await largerThanStorage(item)) {
        await updateItem(item.id, {
          state: 'error',
          error: `ファイルが容量の上限より大きいため保存できません（${formatBytes(item.size)}）`,
        });
        await logEvent('error', `容量の上限より大きいため保存できません: ${item.name}`);
        return;
      }
      // しばらく新しい件を始めず、空き容量を調べ直してから続ける
      await updateItem(item.id, { state: 'pending', note: '容量の空き待ち' });
      await logEvent('warn', `容量が足りないため待機: ${item.name}`);
      capacityWaitUntil = Date.now() + CAPACITY_WAIT_MS;
      budget = null;
      return;
    }
    if (e instanceof LinkexLoginError || /Motrixに接続できません|Motrixのエラー: .*unauthorized/i.test(errorText(e))) {
      // ログイン切れやMotrix側の問題は件ごとの失敗に数えず、全体を止めて知らせる
      await stopWithNotice(errorText(e));
      return;
    }
    await fail(item, errorText(e));
  }
}

/** ファイルが容量の上限そのものより大きいか（確認できなければ false） */
async function largerThanStorage(item: QueueItem): Promise<boolean> {
  if (item.size === null) return false;
  try {
    const usage = await api.usage();
    return usage.totalSpace > 0 && item.size > usage.totalSpace;
  } catch {
    return false;
  }
}

/** 全体を一時停止して、処理ログと通知で知らせる */
async function stopWithNotice(reason: string): Promise<void> {
  await writeEngine({ paused: true, message: `一時停止: ${reason}` });
  await logEvent('error', `一時停止: ${reason}`);
  await notify('stopped', '一時停止しました', reason);
}

async function fail(item: QueueItem, message: string): Promise<void> {
  const attempts = item.attempts + 1;
  // まだ自分のストレージにコピーが残っている場合は、消してからやり直す
  const keepForDelete =
    Boolean(item.destFileId) &&
    (item.state === 'copied' || item.state === 'deleting') &&
    attempts < MAX_ATTEMPTS + 2;
  await updateItem(item.id, {
    attempts,
    error: message,
    state: keepForDelete ? 'deleting' : attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
    note: keepForDelete ? '失敗したコピーを削除します' : undefined,
  });
  const final = !keepForDelete && attempts >= MAX_ATTEMPTS;
  await logEvent(final ? 'error' : 'warn', `${final ? 'エラー' : '失敗（再試行します）'}: ${item.name} — ${message}`);
  if (!keepForDelete) await sleep(2_000);
}

/** 自分のファイル（ルート）のID一覧 */
async function listRootIds(): Promise<Map<string, any>> {
  const list = await collectPages((page) => api.rootFiles(page));
  const map = new Map<string, any>();
  for (const item of list) {
    const f = unwrapFile(item);
    if (f?.id) map.set(String(f.id), f);
  }
  return map;
}

async function stepCopy(item: QueueItem): Promise<void> {
  if (!item.force && item.hash && (await readHashes())[item.hash]) {
    await updateItem(item.id, { state: 'skipped', note: '同じ中身をダウンロード済み' });
    await logEvent('info', `重複のため省略: ${item.name}`);
    return;
  }
  const before = await listRootIds();
  await updateItem(item.id, {
    state: 'copying',
    beforeIds: [...before.keys()],
    copyStartedAt: Date.now(),
    copiedAt: undefined,
    destFileId: undefined,
    gid: undefined,
    note: undefined,
    error: undefined,
  });

  const res = await api.copyFromShare(item.shareToken, item.sourceFileId);
  const taskId = res?.taskId ?? res?.task?.id;
  // 応答の時点で保存が終わっていれば、完了待ちを省く
  const doneAlready = String(res?.task?.status ?? res?.status ?? '').toLowerCase() === 'success';
  if (taskId && !doneAlready) await waitTask(String(taskId));
  await updateItem(item.id, { copiedAt: Date.now() });

  const fresh = (await readQueue()).find((i) => i.id === item.id);
  if (fresh) await stepFindCopy(fresh);
}

async function waitTask(taskId: string): Promise<void> {
  const started = Date.now();
  // 小さいファイルはすぐ終わることが多いので、最初は短く待ち、だんだん間隔を広げる
  let delay = 400;
  while (Date.now() - started < COPY_TIMEOUT_MS) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
    const data = await api.task(taskId);
    const task = data?.task ?? data;
    const status = String(task?.status ?? '').toLowerCase();
    if (status === 'success') return;
    if (status === 'insufficient_storage') {
      throw new LinkexError('容量が足りません', DISK_SPACE_FULL, task);
    }
    if (/fail|error|cancel/.test(status)) throw new Error(`保存に失敗しました（${status}）`);
  }
  throw new Error('保存が5分以内に終わりませんでした');
}

/**
 * 保存前になかったファイルのうち、名前が同じものを「自分が作ったコピー」とみなす。
 * 共有一覧のサイズは実際とずれることがあるので、サイズが合うものを優先し、
 * 合うものがなくても同じ名前の新しいファイルが1つだけならそれを使う。
 */
async function stepFindCopy(item: QueueItem): Promise<void> {
  const before = new Set(item.beforeIds ?? []);
  const now = await listRootIds();
  const fresh = [...now.entries()].filter(([id]) => !before.has(id)).map(([, f]) => f);
  const sizeOf = (f: any) => Number(f.size);
  // 同時に進めているほかの件のコピーとして決まったファイルは選ばない
  const found = findOwnCopy(fresh, item, await claimedByOthers(item.id));

  if (!found) {
    // 保存が終わってから少し待っても出てこなければ、保存し直す（再試行するとすぐ見つかることが多い）
    const since = item.copiedAt ?? item.copyStartedAt ?? 0;
    const limit = item.copiedAt ? COPY_FIND_MS : COPY_TIMEOUT_MS;
    if (Date.now() - since < limit) {
      await sleep(2_000);
      return; // 次の周回でもう一度探す
    }
    const seen = fresh.slice(0, 5).map((f) => `${f.name}（${formatBytes(sizeOf(f))}）`).join('、');
    throw new Error(
      `保存したはずのファイルが見つかりません（新しく増えたファイル ${fresh.length}件${seen ? `: ${seen}` : ''}）`,
    );
  }
  await updateItem(item.id, { state: 'copied', destFileId: String(found.id) });
}

/** ほかの件のコピーとして決まっている、自分のストレージのファイルID */
async function claimedByOthers(id: string): Promise<Set<string>> {
  const items = await readQueue();
  return new Set(items.filter((i) => i.id !== id && i.destFileId).map((i) => String(i.destFileId)));
}

async function stepSend(item: QueueItem): Promise<void> {
  if (!item.destFileId) throw new Error('コピーのIDがありません');
  const data = await api.fileGet(item.destFileId);
  const file = data?.file ?? data;
  const url = String(file?.url ?? '');
  const hash = contentHash(file) ?? item.hash;

  if (!item.force && hash && (await readHashes())[hash]) {
    await updateItem(item.id, { state: 'deleting', hash, note: '同じ中身をダウンロード済み' });
    return;
  }
  if (!url) throw new Error('ダウンロードURLを取得できませんでした');

  // 再試行のときは、途中まで落としたファイルがあれば続きから取る
  const gid = await addDownload(url, { dir: item.relDir, out: item.outName, resume: item.attempts > 0 });
  await updateItem(item.id, { state: 'deleting', hash, gid, note: undefined });
  await logEvent('info', `Motrixへ渡しました: ${item.relDir}\\${item.outName}`);
}

/** Motrixに渡した直後に、自分のストレージのコピーを完全削除して容量を空ける */
async function stepDelete(item: QueueItem): Promise<void> {
  const destId = item.destFileId;
  if (!destId) throw new Error('削除するコピーのIDがありません');
  // 安全確認: 保存前から存在したファイルは絶対に消さない
  if ((item.beforeIds ?? []).includes(destId)) {
    await updateItem(item.id, { state: 'error', error: '削除対象が保存前から存在していたため、削除を中止しました' });
    return;
  }
  // 安全確認: ほかの件のコピーとして決まったファイルは消さない
  if ((await claimedByOthers(item.id)).has(destId)) {
    await updateItem(item.id, { state: 'error', error: '削除対象がほかの件のコピーと重なったため、削除を中止しました' });
    return;
  }

  try {
    await api.moveToTrash(destId);
  } catch {
    // すでにゴミ箱にある場合などは、そのまま完全削除へ進む
  }
  await api.deleteForever(destId);

  const after: Partial<QueueItem> = { destFileId: undefined, beforeIds: undefined };
  if (item.gid) {
    await updateItem(item.id, { ...after, state: 'downloading', note: undefined });
  } else if (item.note === '同じ中身をダウンロード済み') {
    await updateItem(item.id, { ...after, state: 'skipped' });
  } else {
    // 失敗したコピーを片付けた場合は、共有から保存し直す
    await updateItem(item.id, {
      ...after,
      state: item.attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
      note: undefined,
    });
  }
}

/** 進み具合だけの変化は、この間隔より短くは保存しない（画面はMotrixから直接取っている） */
const PROGRESS_SAVE_MS = 30_000;
const progressSavedAt = new Map<string, number>();

/**
 * Motrixのダウンロード状況を取り込み、完了・失敗を反映する。
 * キュー全体の書き込みは重く、書くたびに画面も描き直されるので、変更はまとめて1回で書く
 */
export async function refreshDownloads(): Promise<void> {
  const items = (await readQueue()).filter((i) => i.state === 'downloading' && i.gid);
  const patches = new Map<string, Partial<QueueItem>>();
  const logs: [Parameters<typeof logEvent>[0], string][] = [];
  let stopped: Aria2Status[] | null = null;
  for (const item of items) {
    let status: Aria2Status | undefined;
    try {
      status = await tellStatus(item.gid!);
    } catch (e) {
      if (!/not found/i.test(errorText(e))) continue; // Motrixに一時的につながらない場合は次回また確認
      // 完了したダウンロードをMotrixが履歴から消していることがある。停止済み一覧も探す
      try {
        stopped ??= await tellStopped();
      } catch {
        continue;
      }
      status = stopped.find((s) => s.gid === item.gid);
      if (!status) {
        // 履歴に残っていない。Motrixに渡せた時点で成功とみなす（完了確認オフの要件）
        if (item.hash) await rememberHash(item.hash, item.name);
        patches.set(item.id, { state: 'done', gid: undefined, note: 'Motrixの履歴になし' });
        logs.push(['info', `完了（Motrixの履歴になし）: ${item.name}`]);
        continue;
      }
    }
    const progress = {
      totalLength: Number(status.totalLength) || undefined,
      completedLength: Number(status.completedLength) || 0,
    };
    if (status.status === 'complete') {
      if (item.hash) await rememberHash(item.hash, item.name);
      patches.set(item.id, { ...progress, state: 'done', gid: undefined });
      logs.push(['info', `完了: ${item.name}`]);
    } else if (status.status === 'error') {
      const attempts = item.attempts + 1;
      const reason = status.errorMessage ?? status.errorCode ?? '不明';
      patches.set(item.id, {
        ...progress,
        attempts,
        gid: undefined,
        state: attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
        error: `Motrixでのダウンロード失敗: ${reason}`,
      });
      logs.push([attempts >= MAX_ATTEMPTS ? 'error' : 'warn', `Motrixでのダウンロード失敗: ${item.name} — ${reason}`]);
    } else if (status.status === 'removed') {
      patches.set(item.id, { state: 'error', gid: undefined, error: 'Motrixでダウンロードが取り消されました' });
      logs.push(['warn', `Motrixで取り消されました: ${item.name}`]);
    } else {
      // 進み具合だけなら、変わっていて、前に保存してから時間がたったときだけ書く
      const changed =
        progress.totalLength !== item.totalLength || progress.completedLength !== (item.completedLength ?? 0);
      const due = Date.now() - (progressSavedAt.get(item.id) ?? 0) >= PROGRESS_SAVE_MS;
      if (changed && (due || progress.totalLength !== item.totalLength)) {
        patches.set(item.id, progress);
        progressSavedAt.set(item.id, Date.now());
      }
    }
  }
  // 確認しているあいだに外されたり状態が変わったりした件は書き換えない
  const gidOf = new Map(items.map((i) => [i.id, i.gid]));
  await updateItems(patches, (i) => i.state === 'downloading' && i.gid === gidOf.get(i.id));
  for (const [id, patch] of patches) if (patch.state) progressSavedAt.delete(id);
  for (const [level, message] of logs) await logEvent(level, message);
}
