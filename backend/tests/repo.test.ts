import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRepo } from '../src/domain/repo.ts';
import { migrate } from '../src/domain/migrate.ts';

function fresh() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, repo: createRepo(db) };
}

test('claim → complete 幂等', () => {
  const { repo } = fresh();
  repo.insertTask({ id: 't1', inputId: null, kind: 'plan_input', state: 'queued' });
  const claimed = repo.claimTask('w1', 60_000);
  assert.equal(claimed.id, 't1');
  assert.equal(claimed.state, 'running');
  // 已在运行且未过期，不能再被领到
  assert.equal(repo.claimTask('w2', 60_000), undefined);
  repo.completeTask('t1', claimed.lease_token, 'ref1');
  assert.equal(repo.getTask('t1').state, 'succeeded');
  assert.equal(repo.claimTask('w3', 60_000), undefined);
});

test('过期租约可被再次认领', () => {
  const { db, repo } = fresh();
  repo.insertTask({ id: 't1', inputId: null, kind: 'plan_input', state: 'queued' });
  repo.claimTask('w1', 60_000);
  db.prepare('UPDATE task SET lease_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), 't1');
  const again = repo.claimTask('w2', 60_000);
  assert.equal(again.id, 't1');
  assert.equal(Number(again.attempt), 2);
});

test('过期租约拒绝提交 / 续活', () => {
  const { db, repo } = fresh();
  repo.insertTask({ id: 't1', inputId: null, kind: 'plan_input', state: 'queued' });
  const claimed = repo.claimTask('w1', 60_000);
  db.prepare('UPDATE task SET lease_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), 't1');
  assert.throws(() => repo.completeTask('t1', claimed.lease_token, null), (e: any) => e.code === 'DEPENDENCY');
  assert.throws(() => repo.heartbeatTask('t1', claimed.lease_token, 60_000), (e: any) => e.code === 'DEPENDENCY');
});

test('failTask 记录错误码', () => {
  const { repo } = fresh();
  repo.insertTask({ id: 't1', inputId: null, kind: 'plan_input', state: 'queued' });
  const claimed = repo.claimTask('w1', 60_000);
  repo.failTask('t1', claimed.lease_token, 'model_timeout');
  assert.equal(repo.getTask('t1').state, 'failed');
  assert.equal(repo.getTask('t1').error_code, 'model_timeout');
});

test('transaction 回滚', () => {
  const { db, repo } = fresh();
  assert.throws(() => repo.transaction(() => {
    repo.insertTask({ id: 'tx1', inputId: null, kind: 'plan_input', state: 'queued' });
    throw new Error('boom');
  }));
  assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM task').get() as any).n), 0);
});
