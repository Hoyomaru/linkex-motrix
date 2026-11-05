import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLogin } from '../src/shared/auth.ts';

test('昔の保存場所（linkex_credentials）にログイン情報があれば、ログインしている', () => {
  assert.equal(judgeLogin([['linkex_credentials', '{"token":"x","refreshToken":"x"}']]), true);
});

test('今の保存場所（user_cache）の中にトークンがあれば、ログインしている', () => {
  const v = JSON.stringify({ u1: { credentials: { data: { token: 'x', refreshToken: 'x' } }, profile: {} } });
  assert.equal(judgeLogin([['linkex_user_cache_v1', v]]), true);
});

test('ログイン情報の入れ物はあるがトークンが空なら、ログインしていない', () => {
  const v = JSON.stringify({ u1: { credentials: { token: '', refreshToken: '' } } });
  assert.equal(judgeLogin([['linkex_user_cache_v1', v]]), false);
});

test('入れ物にログイン情報がなければ、ログインしていない', () => {
  assert.equal(judgeLogin([['linkex_user_cache_v1', '{"u1":{"profile":{}}}']]), false);
});

test('どちらの保存場所も見つからなければ、分からない（ログイン切れと決めつけない）', () => {
  assert.equal(judgeLogin([]), null);
});

test('保存のしかたが読めない形なら、分からない', () => {
  assert.equal(judgeLogin([['linkex_user_cache_v1', 'not json']]), null);
});
