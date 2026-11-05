import type { ItemState, QueueItem } from './queue';

/** 自分のストレージにコピーを置いている段階（保存〜削除） */
export const PREP_STATES: ItemState[] = ['copying', 'copied', 'deleting'];
const WAITING_STATES: ItemState[] = ['pending', 'retry'];

export interface PickContext {
  /** いま担当が動いている件のID */
  running: Set<string>;
  /** 保存〜削除を同時に進める数 */
  parallel: number;
  /** 保存中のコピーの合計がこれを超えないようにする（バイト） */
  budgetBytes: number;
  /** Motrixの同時ダウンロード数（保存中の件も、すぐダウンロードに回るので数に入れる） */
  maxDownloads: number;
  /** false なら新しい件は始めず、途中の件の再開だけをする（容量の空き待ちなど） */
  allowNew: boolean;
}

/**
 * 次に担当を付けて始める件のIDを返す。
 * 安全のための決まり:
 * - 同じ名前のファイルは同時に保存しない（コピーを名前で見分けているため、取り違えて消さないように）
 * - 保存中のコピーの合計が容量の枠を超えないようにする。サイズ不明の件は単独で進める
 * - キューの順番は飛ばさない（同じ名前の件だけは後回しにする）。大きい件がいつまでも始まらなくなるのを防ぐ
 */
export function pickStarts(items: QueueItem[], ctx: PickContext): string[] {
  const starts: string[] = [];
  // 担当が付いたばかりで、まだ待ちの状態のままの件も、保存中と同じに数える
  const prep = items.filter((i) => PREP_STATES.includes(i.state) || ctx.running.has(i.id));

  // 保存の途中で担当がいない件（Service Worker が止められた後など）は、まず再開する
  for (const i of prep) if (!ctx.running.has(i.id)) starts.push(i.id);
  if (!ctx.allowNew) return starts;

  let slots = ctx.parallel - ctx.running.size - starts.length;
  let downloads = items.filter((i) => i.state === 'downloading').length + prep.length;
  let busy = prep.length;
  let unknownBusy = prep.some((i) => i.size === null);
  let used = prep.reduce((sum, i) => sum + (i.size ?? 0), 0);
  const names = new Set(prep.map((i) => i.name));

  for (const i of items) {
    if (slots <= 0 || downloads >= ctx.maxDownloads || unknownBusy) break;
    if (!WAITING_STATES.includes(i.state) || ctx.running.has(i.id)) continue;
    if (names.has(i.name)) continue;
    if (i.size === null) {
      if (busy > 0) break;
      unknownBusy = true;
    } else if (busy > 0 && used + i.size > ctx.budgetBytes) {
      break;
    }
    starts.push(i.id);
    names.add(i.name);
    used += i.size ?? 0;
    busy++;
    slots--;
    downloads++;
  }
  return starts;
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdAt?: number;
}

/**
 * 保存前になかったファイル（fresh）から、この件のコピーを選ぶ。
 * ほかの件のコピーとして決まったもの（claimed）は選ばない。
 * サイズが合うものを優先し、合うものがなくても同じ名前のものが1つだけならそれを使う。
 */
export function findOwnCopy<T extends DriveFile>(fresh: T[], item: QueueItem, claimed: Set<string>): T | undefined {
  const sameName = fresh
    .filter((f) => String(f.name) === item.name && !claimed.has(String(f.id)))
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const exact = sameName.filter((f) => item.size === null || Number(f.size) === item.size);
  return exact[0] ?? (sameName.length === 1 ? sameName[0] : undefined);
}
