import { sanitizeName, withNumber } from '../shared/files';
import type { QueueItem } from '../shared/queue';
import { parseShareTokens } from '../shared/share-url';
import type { WalkedFile } from './linkex-bridge';
import { walkShareInTab } from './linkex-tab';
import { mutateQueue } from './store';

export interface EnqueueResult {
  added: number;
  alreadyQueued: number;
  invalid: string[];
  failed: { token: string; error: string }[];
  elapsedMs: number;
}

/** 同時に読む共有リンクの数 */
const SHARE_CONCURRENCY = 3;

export async function enqueueShares(text: string): Promise<EnqueueResult> {
  const startedAt = Date.now();
  const { tokens, invalid } = parseShareTokens(text);
  const result: EnqueueResult = { added: 0, alreadyQueued: 0, invalid, failed: [], elapsedMs: 0 };

  // 貼った順番どおりにキューへ並ぶよう、読み終わった順ではなく元の順で追加する
  const walked: ({ shareName: string; files: WalkedFile[] } | null)[] = new Array(tokens.length).fill(null);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tokens.length) {
      const index = nextIndex++;
      const token = tokens[index];
      const res = await walkShareInTab(token).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
      if (res.ok) {
        walked[index] = { shareName: res.shareName, files: res.files };
      } else {
        result.failed.push({ token, error: res.error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHARE_CONCURRENCY, tokens.length) }, worker));

  await mutateQueue((items) => {
    const now = Date.now();
    tokens.forEach((token, index) => {
      const share = walked[index];
      if (!share) return;
      for (const f of share.files) {
        if (items.some((i) => i.shareToken === token && i.sourceFileId === f.id)) {
          result.alreadyQueued++;
          continue;
        }
        const relDir = [sanitizeName(share.shareName, token), ...f.folders.map((d) => sanitizeName(d))].join('\\');
        const base = sanitizeName(f.name);
        let outName = base;
        for (let n = 2; items.some((i) => i.relDir === relDir && i.outName === outName); n++) {
          outName = withNumber(base, n);
        }
        const item: QueueItem = {
          id: `${token}:${f.id}`,
          shareToken: token,
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
        result.added++;
      }
    });
  });

  result.elapsedMs = Date.now() - startedAt;
  return result;
}
