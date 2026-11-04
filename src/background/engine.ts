import { contentHash, formatBytes, unwrapFile } from '../shared/files';
import type { QueueItem } from '../shared/queue';
import { loadSettings } from '../shared/settings';
import { api, collectPages, DISK_SPACE_FULL, LinkexError } from './api';
import { LinkexLoginError } from './linkex-tab';
import { addDownload, tellStatus, tellStopped, type Aria2Status } from './motrix';
import { notify } from './notify';
import { logEvent, readEngine, readHashes, readQueue, rememberHash, updateItem, writeEngine } from './store';

const MAX_ATTEMPTS = 3;
const COPY_TIMEOUT_MS = 5 * 60_000;
/** 保存が終わってから、コピーが一覧に出てくるのを待つ時間 */
const COPY_FIND_MS = 60_000;
const IDLE_WAIT_MS = 3_000;
const TRAFFIC_RECHECK_MS = 5 * 60_000;
const CAPACITY_WAIT_MS = 30_000;
const TRAFFIC_WAIT_MESSAGE = '転送量の上限に達したため待機中（設定で変更できます）';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (e: unknown) => String((e as Error)?.message ?? e);

let loopRunning = false;

/** キューを処理するループを起動する（すでに動いていれば何もしない） */
export function kick(): void {
  if (loopRunning) return;
  loopRunning = true;
  runLoop()
    .catch(async (e) => {
      await writeEngine({ message: `処理が止まりました: ${errorText(e)}` });
    })
    .finally(() => {
      loopRunning = false;
    });
}

export async function start(): Promise<void> {
  await writeEngine({ paused: false, message: '開始しました' });
  await logEvent('info', '処理を開始しました');
  kick();
}

export async function pause(): Promise<void> {
  // 処理中の1件は区切りのよいところまで進めてから止まる
  await writeEngine({ paused: true, message: '一時停止中' });
  await logEvent('info', '一時停止しました');
}

async function runLoop(): Promise<void> {
  while (true) {
    const engine = await readEngine();
    if (engine.paused) return;

    const settings = await loadSettings();
    await refreshDownloads();
    const items = await readQueue();

    // 途中で止まっていた件（保存中など）を最優先で片付ける
    const resumable = items.find((i) => i.state === 'copying' || i.state === 'copied' || i.state === 'deleting');
    const downloading = items.filter((i) => i.state === 'downloading').length;
    const next = resumable ?? items.find((i) => i.state === 'pending' || i.state === 'retry');

    if (!next) {
      if (downloading === 0) {
        await writeEngine({ paused: true, message: 'すべて終わりました' });
        await logEvent('info', 'キューの処理がすべて終わりました');
        const done = items.filter((i) => i.state === 'done').length;
        const errors = items.filter((i) => i.state === 'error').length;
        await notify(
          'finished',
          errors ? `終わりました（失敗 ${errors}件）` : 'すべて終わりました',
          `完了 ${done}件${errors ? `・失敗 ${errors}件。専用ページで再試行できます` : ''}`,
        );
        return;
      }
      await writeEngine({ message: `ダウンロード中 ${downloading}件` });
      await sleep(IDLE_WAIT_MS);
      continue;
    }

    if (!resumable && downloading >= settings.maxDownloads) {
      await writeEngine({ message: `ダウンロード中 ${downloading}件（空き待ち）` });
      await sleep(IDLE_WAIT_MS);
      continue;
    }

    if (!resumable && settings.pauseOnTrafficLimit && (await trafficExhausted())) {
      // 待機中に Service Worker が止められると1分ごとの見回りでここに戻ってくるので、
      // ログは待機に入った最初の1回だけ書く
      if (engine.message !== TRAFFIC_WAIT_MESSAGE) {
        await logEvent('warn', '転送量の上限に達したため待機します（5分ごとに確認）');
      }
      await writeEngine({ message: TRAFFIC_WAIT_MESSAGE });
      await sleep(TRAFFIC_RECHECK_MS);
      continue;
    }

    await processItem(next);
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
  await writeEngine({ message: `${item.name}` });
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
      await updateItem(item.id, { state: 'pending', note: '容量の空き待ち' });
      await logEvent('warn', `容量が足りないため待機: ${item.name}`);
      await sleep(CAPACITY_WAIT_MS);
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
  const usage = await api.usage();
  if (item.size !== null && usage.totalSpace > 0 && item.size > usage.totalSpace) {
    await updateItem(item.id, {
      state: 'error',
      error: `ファイルが容量の上限より大きいため保存できません（${formatBytes(item.size)}）`,
    });
    await logEvent('error', `容量の上限より大きいため保存できません: ${item.name}`);
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
  if (taskId) await waitTask(String(taskId));
  await updateItem(item.id, { copiedAt: Date.now() });

  const fresh = (await readQueue()).find((i) => i.id === item.id);
  if (fresh) await stepFindCopy(fresh);
}

async function waitTask(taskId: string): Promise<void> {
  const started = Date.now();
  let delay = 1000;
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
  const sameName = fresh
    .filter((f) => String(f.name) === item.name)
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const sizeOf = (f: any) => Number(f.size);
  const exact = sameName.filter((f) => item.size === null || sizeOf(f) === item.size);
  const found = exact[0] ?? (sameName.length === 1 ? sameName[0] : undefined);

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

/** Motrixのダウンロード状況を取り込み、完了・失敗を反映する */
export async function refreshDownloads(): Promise<void> {
  const items = (await readQueue()).filter((i) => i.state === 'downloading' && i.gid);
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
        await updateItem(item.id, { state: 'done', gid: undefined, note: 'Motrixの履歴になし' });
        await logEvent('info', `完了（Motrixの履歴になし）: ${item.name}`);
        continue;
      }
    }
    const progress = {
      totalLength: Number(status.totalLength) || undefined,
      completedLength: Number(status.completedLength) || 0,
    };
    if (status.status === 'complete') {
      if (item.hash) await rememberHash(item.hash, item.name);
      await updateItem(item.id, { ...progress, state: 'done', gid: undefined });
      await logEvent('info', `完了: ${item.name}`);
    } else if (status.status === 'error') {
      const attempts = item.attempts + 1;
      await updateItem(item.id, {
        ...progress,
        attempts,
        gid: undefined,
        state: attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
        error: `Motrixでのダウンロード失敗: ${status.errorMessage ?? status.errorCode ?? '不明'}`,
      });
      await logEvent(attempts >= MAX_ATTEMPTS ? 'error' : 'warn', `Motrixでのダウンロード失敗: ${item.name} — ${status.errorMessage ?? status.errorCode ?? '不明'}`);
    } else if (status.status === 'removed') {
      await updateItem(item.id, { state: 'error', gid: undefined, error: 'Motrixでダウンロードが取り消されました' });
      await logEvent('warn', `Motrixで取り消されました: ${item.name}`);
    } else {
      await updateItem(item.id, progress);
    }
  }
}
