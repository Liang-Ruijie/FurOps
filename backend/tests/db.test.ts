import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inTx, withBusyRetry, changed } from '../src/domain/db.ts';

function mem(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a INTEGER)');
  return db;
}

test('inTx 提交', () => {
  const db = mem();
  inTx(db, () => { db.prepare('INSERT INTO t VALUES(1)').run(); });
  assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM t').get() as any).n), 1);
});

test('inTx 回滚', () => {
  const db = mem();
  assert.throws(() => inTx(db, () => {
    db.prepare('INSERT INTO t VALUES(1)').run();
    throw new Error('boom');
  }));
  assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM t').get() as any).n), 0);
});

test('withBusyRetry 对 SQLITE_BUSY 重试后成功', () => {
  let calls = 0;
  const r = withBusyRetry(() => { calls++; if (calls < 2) throw new Error('SQLITE_BUSY: database is locked'); return 42; });
  assert.equal(r, 42);
  assert.equal(calls, 2);
});

test('withBusyRetry 非 BUSY 直接抛', () => {
  assert.throws(() => withBusyRetry(() => { throw new Error('boom'); }), /boom/);
});

test('withBusyRetry 全部 BUSY 抛 STORAGE_BUSY', () => {
  assert.throws(
    () => withBusyRetry(() => { throw new Error('SQLITE_BUSY'); }),
    (e: any) => e.code === 'STORAGE_BUSY' && e.retryable === true
  );
});

test('changed 判断变更', () => {
  const db = mem();
  assert.equal(changed(db.prepare('INSERT INTO t VALUES(1)').run()), true);
  assert.equal(changed(db.prepare('DELETE FROM t WHERE a=99').run()), false);
});
