import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOwnCopy, pickStarts, type PickContext } from '../src/shared/scheduler.ts';
import type { QueueItem } from '../src/shared/queue.ts';

const GB = 1024 ** 3;

let seq = 0;
function item(patch: Partial<QueueItem> = {}): QueueItem {
  seq++;
  return {
    id: `id${seq}`,
    shareToken: 't',
    shareName: 's',
    sourceFileId: `f${seq}`,
    name: `file${seq}.mp4`,
    size: 100,
    relDir: 's',
    outName: `file${seq}.mp4`,
    hash: null,
    state: 'pending',
    attempts: 0,
    addedAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const ctx = (patch: Partial<PickContext> = {}): PickContext => ({
  running: new Set(),
  parallel: 3,
  budgetBytes: 5 * GB,
  maxDownloads: 5,
  allowNew: true,
  ...patch,
});

test('待ちの件を、同時に処理する数までキューの順に始める', () => {
  const items = [item(), item(), item(), item()];
  assert.deepEqual(pickStarts(items, ctx()), [items[0].id, items[1].id, items[2].id]);
});

test('同時に処理する数が1なら、1件ずつ進める', () => {
  const items = [item(), item()];
  assert.deepEqual(pickStarts(items, ctx({ parallel: 1 })), [items[0].id]);
});

test('すでに動いている件の分だけ、新しく始める数を減らす', () => {
  const busy = item({ state: 'copying' });
  const items = [busy, item(), item(), item()];
  assert.deepEqual(pickStarts(items, ctx({ running: new Set([busy.id]) })), [items[1].id, items[2].id]);
});

test('保存の途中で担当がいない件（再開後など）は、制限に関係なく先に再開する', () => {
  const a = item({ state: 'copying' });
  const b = item({ state: 'deleting' });
  const items = [item(), a, b];
  assert.deepEqual(pickStarts(items, ctx({ parallel: 1, allowNew: false })), [a.id, b.id]);
});

test('保存中の件と同じ名前のファイルは同時に始めず、別の名前の件を先に進める', () => {
  const busy = item({ state: 'copying', name: 'cover.jpg' });
  const same = item({ name: 'cover.jpg' });
  const other = item({ name: 'other.jpg' });
  const items = [busy, same, other];
  assert.deepEqual(pickStarts(items, ctx({ running: new Set([busy.id]) })), [other.id]);
});

test('同時に始める件どうしでも、同じ名前は1件だけにする', () => {
  const a = item({ name: 'cover.jpg' });
  const b = item({ name: 'cover.jpg' });
  const c = item({ name: 'x.jpg' });
  assert.deepEqual(pickStarts([a, b, c], ctx()), [a.id, c.id]);
});

test('保存中の合計が容量の枠を超えるなら、次の件を始めない', () => {
  const busy = item({ state: 'copying', size: 3 * GB });
  const big = item({ size: 3 * GB });
  const small = item({ size: 1 * GB });
  const items = [busy, big, small];
  // 順番を飛ばして小さい件を先にすると、大きい件がいつまでも始まらないので待つ
  assert.deepEqual(pickStarts(items, ctx({ running: new Set([busy.id]) })), []);
});

test('枠ちょうどまでは始める', () => {
  const a = item({ size: 2 * GB });
  const b = item({ size: 3 * GB });
  assert.deepEqual(pickStarts([a, b], ctx()), [a.id, b.id]);
});

test('枠より大きいファイルでも、ほかに保存中の件がなければ1件だけで始める', () => {
  const big = item({ size: 6 * GB });
  const next = item({ size: 1 });
  assert.deepEqual(pickStarts([big, next], ctx()), [big.id]);
});

test('サイズが分からない件は、ほかに何もないときに1件だけで始める', () => {
  const unknown = item({ size: null });
  const next = item();
  assert.deepEqual(pickStarts([unknown, next], ctx()), [unknown.id]);
});

test('サイズが分からない件を保存中なら、新しい件を始めない', () => {
  const busy = item({ state: 'copied', size: null });
  assert.deepEqual(pickStarts([busy, item()], ctx({ running: new Set([busy.id]) })), []);
});

test('サイズが分からない件は、ほかに保存中の件があれば始めない', () => {
  const busy = item({ state: 'copying' });
  const unknown = item({ size: null });
  assert.deepEqual(pickStarts([busy, unknown], ctx({ running: new Set([busy.id]) })), []);
});

test('ダウンロード中と保存中の合計が同時ダウンロード数に達したら、新しい件を始めない', () => {
  const items = [item({ state: 'downloading' }), item({ state: 'downloading' }), item(), item(), item()];
  assert.deepEqual(pickStarts(items, ctx({ maxDownloads: 3 })), [items[2].id]);
});

test('新しく始めてよくないとき（容量の空き待ちなど）は、待ちの件を始めない', () => {
  assert.deepEqual(pickStarts([item(), item()], ctx({ allowNew: false })), []);
});

test('担当が付いたばかりで、まだ待ちの状態の件も保存中として数える（同じ名前を始めない）', () => {
  const starting = item({ name: 'cover.jpg' });
  const same = item({ name: 'cover.jpg' });
  assert.deepEqual(pickStarts([starting, same], ctx({ running: new Set([starting.id]) })), []);
});

test('担当が付いたばかりで、まだ待ちの状態の件のサイズも容量の枠に数える', () => {
  const starting = item({ size: 4 * GB });
  const next = item({ size: 2 * GB });
  assert.deepEqual(pickStarts([starting, next], ctx({ running: new Set([starting.id]) })), []);
});

test('再試行待ちの件も、待ちの件と同じように始める', () => {
  const r = item({ state: 'retry' });
  assert.deepEqual(pickStarts([item({ state: 'done' }), r], ctx()), [r.id]);
});

// ---------- 自分が作ったコピーの見分け ----------

const file = (id: string, name: string, size: number, createdAt = 0) => ({ id, name, size, createdAt });

test('名前とサイズが同じ新しいファイルを、自分のコピーとみなす', () => {
  const target = item({ name: 'a.mp4', size: 100 });
  const found = findOwnCopy([file('x', 'b.mp4', 100), file('y', 'a.mp4', 100)], target, new Set());
  assert.equal(found?.id, 'y');
});

test('ほかの件のコピーとして決まったファイルは選ばない', () => {
  const target = item({ name: 'a.mp4', size: 100 });
  const found = findOwnCopy([file('x', 'a.mp4', 100)], target, new Set(['x']));
  assert.equal(found, undefined);
});

test('サイズが合うものがなくても、同じ名前の新しいファイルが1つだけならそれを使う', () => {
  const target = item({ name: 'a.mp4', size: 100 });
  assert.equal(findOwnCopy([file('x', 'a.mp4', 999)], target, new Set())?.id, 'x');
});

test('サイズが合わない同じ名前のファイルが2つ以上あれば、どれか決められないので選ばない', () => {
  const target = item({ name: 'a.mp4', size: 100 });
  assert.equal(findOwnCopy([file('x', 'a.mp4', 1), file('y', 'a.mp4', 2)], target, new Set()), undefined);
});

test('サイズの合うものが複数あれば、いちばん新しく作られたものを選ぶ', () => {
  const target = item({ name: 'a.mp4', size: 100 });
  const found = findOwnCopy([file('old', 'a.mp4', 100, 1), file('new', 'a.mp4', 100, 2)], target, new Set());
  assert.equal(found?.id, 'new');
});
