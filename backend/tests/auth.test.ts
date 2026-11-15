import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, newSessionToken, sha256, uuid, nowIso } from '../src/domain/auth.ts';

test('口令哈希往返', async () => {
  const h = await hashPassword('pw123');
  assert.match(h, /^\$argon2id\$/);
  assert.equal(await verifyPassword('pw123', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});

test('verifyPassword 非法串返回 false', async () => {
  assert.equal(await verifyPassword('x', 'not-a-valid-hash'), false);
});

test('会话 token：长度 64 且服务端存 sha256 摘要', () => {
  const { token, tokenHash } = newSessionToken();
  assert.equal(token.length, 64);
  assert.equal(sha256(token), tokenHash);
  assert.notEqual(token, tokenHash);
});

test('uuid / nowIso 基本形态', () => {
  assert.ok(uuid().length > 0);
  assert.match(nowIso(), /Z$/);
});
