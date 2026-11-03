import { sanitizeName, withNumber } from '../shared/files';
import type { QueueItem } from '../shared/queue';
import { parseShareTokens } from '../shared/share-url';
import type { WalkedFile } from './linkex-bridge';
import { walkShareInTab } from './linkex-tab';
import { mutateQueue } from './store';

export interface EnqueueResult {
  added: number;
  /** 追加したファイルの合計バイト数（サイズ不明は0として数える） */
  addedBytes: number;
  alreadyQueued: number;
  invalid: string[];
  failed: { token: string; error: string }[];
  elapsedMs: number;
}

export interface WalkedShare {
  token: string;
  shareName: string;
  files: WalkedFile[];
}

/** 同時に読む共有リンクの数 */
const SHARE_CONCURRENCY = 3;

/** 貼り付けたURL（複数可）の共有を読み、全ファイルをキューに追加する */
export async function enqueueShares(text: string): Promise<EnqueueResult> {
  const startedAt = Date.now();
  const { tokens, invalid } = parseShareTokens(text);
  const result: EnqueueResult = { added: 0, addedBytes: 0, alreadyQueued: 0, invalid, failed: [], elapsedMs: 0 };

  // 貼った順番どおりにキューへ並ぶよう、読み終わった順ではなく元の順で追加する
  const walked: (WalkedShare | null)[] = new Array(tokens.length).fill(null);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tokens.length) {
      const index = nextIndex++;
      const token = tokens[index];
      const res = await walkShareInTab(token).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
      if (res.ok) {
        walked[index] = { token, shareName: res.shareName, files: res.files };
      } else {
        result.failed.push({ token, error: res.error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHARE_CONCURRENCY, tokens.length) }, worker));

  const counts = await addWalkedToQueue(walked.filter((w): w is WalkedShare => w !== null));
  result.added = counts.added;
  result.addedBytes = counts.addedBytes;
  result.alreadyQueued = counts.alreadyQueued;
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/** 読み終わった共有のファイル（全部または選んだ分）をキューに追加する */
export async function addWalkedToQueue(shares: WalkedShare[]): Promise<{ added: number; addedBytes: number; alreadyQueued: number }> {
  const counts = { added: 0, addedBytes: 0, alreadyQueued: 0 };
  await mutateQueue((items) => {
    const now = Date.now();
    for (const share of shares) {
      for (const f of share.files) {
        if (items.some((i) => i.shareToken === share.token && i.sourceFileId === f.id)) {
          counts.alreadyQueued++;
          continue;
        }
        const relDir = [sanitizeName(share.shareName, share.token), ...f.folders.map((d) => sanitizeName(d))].join('\\');
        const base = sanitizeName(f.name);
        let outName = base;
        for (let n = 2; items.some((i) => i.relDir === relDir && i.outName === outName); n++) {
          outName = withNumber(base, n);
        }
        const item: QueueItem = {
          id: `${share.token}:${f.id}`,
          shareToken: share.token,
          shareName: share.shareName,
          sourceFileId: f.id,
          name: f.name,
          size: f.size,
          relDir,
          outName,
          hash: f.hash,
          state: 'pending',
          attempts: 0,
          addedAt: now,
          updatedAt: now,
        };
        items.push(item);
        counts.added++;
        counts.addedBytes += f.size ?? 0;
      }
    }
  });
  return counts;
}
