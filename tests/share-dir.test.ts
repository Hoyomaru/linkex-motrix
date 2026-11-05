import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relDirFor, singleTopFolder } from '../src/shared/files.ts';

const f = (...folders: string[]) => ({ folders });

test('共有の中身が全部1つのフォルダの下にあれば、そのフォルダ名を返す', () => {
  assert.equal(singleTopFolder([f('まとめ'), f('まとめ', 'A'), f('まとめ', 'B', 'C')]), 'まとめ');
});

test('共有の直下にファイルがあれば、まとめない', () => {
  assert.equal(singleTopFolder([f('まとめ'), f()]), null);
});

test('共有の直下にフォルダが2つ以上あれば、まとめない', () => {
  assert.equal(singleTopFolder([f('A'), f('B')]), null);
});

test('ファイルがなければ、まとめない', () => {
  assert.equal(singleTopFolder([]), null);
});

test('まとめるときは、共有名の段を飛ばしてフォルダから始める', () => {
  assert.equal(relDirFor('N4t7swrR', 'N4t7swrR', ['質良素人まとめ', 'A'], true), '質良素人まとめ\\A');
});

test('まとめないときは、今までどおり共有名の下に置く', () => {
  assert.equal(relDirFor('共有', 'tok', ['A', 'B'], false), '共有\\A\\B');
});

test('共有名が空なら、共有IDをフォルダ名にする', () => {
  assert.equal(relDirFor('', 'tok', [], false), 'tok');
});

test('フォルダ名に使えない文字は置き換える', () => {
  assert.equal(relDirFor('a', 't', ['x:y'], true), 'x_y');
});
