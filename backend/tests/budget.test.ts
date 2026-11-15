import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { SqliteBudgetTracker, NoopBudgetTracker, type BudgetTracker } from '../src/domain/budget.ts';

function makeTracker(limits: { taskLimitFen: number; dayLimitFen: number; monthLimitFen: number }) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const tracker = new SqliteBudgetTracker({ db, limits });
  return { db, tracker };
}

const req = (over: Partial<{ reservedFen: number; taskId: string; requestHash: string }> = {}) => ({
  provider: 'deepseek', model: 'deepseek-chat', capability: 'planner',
  requestHash: over.requestHash ?? 'h1', reservedFen: over.reservedFen ?? 50,
  taskId: over.taskId ?? 't1', rateVersion: 'p2',
});

test('reserve → settle succeeded：预留转实付', () => {
  const { db, tracker } = makeTracker({ taskLimitFen: 100, dayLimitFen: 200, monthLimitFen: 500 });
  const { callId } = tracker.reserve(req());
  tracker.settle(callId, 'succeeded', 40, { input: 1000, output: 100 });
  const mc = db.prepare('SELECT state, actual_fen, reserved_fen FROM model_call WHERE id=?').get(callId) as any;
  assert.equal(mc.state, 'succeeded');
  assert.equal(Number(mc.actual_fen), 40);
  const p = db.prepare("SELECT reserved_fen, spent_fen FROM budget_period WHERE period LIKE 'day:%'").get() as any;
  assert.equal(Number(p.reserved_fen), 0);
  assert.equal(Number(p.spent_fen), 40);
});

test('settle failed：释放预留', () => {
  const { db, tracker } = makeTracker({ taskLimitFen: 100, dayLimitFen: 200, monthLimitFen: 500 });
  const { callId } = tracker.reserve(req());
  tracker.settle(callId, 'failed', 0);
  const p = db.prepare("SELECT reserved_fen, spent_fen FROM budget_period WHERE period LIKE 'day:%'").get() as any;
  assert.equal(Number(p.reserved_fen), 0);
  assert.equal(Number(p.spent_fen), 0);
});

test('settle unknown：保留预留，actual 为 NULL', () => {
  const { db, tracker } = makeTracker({ taskLimitFen: 100, dayLimitFen: 200, monthLimitFen: 500 });
  const { callId } = tracker.reserve(req());
  tracker.settle(callId, 'unknown');
  const mc = db.prepare('SELECT state, actual_fen FROM model_call WHERE id=?').get(callId) as any;
  assert.equal(mc.state, 'unknown');
  assert.equal(mc.actual_fen, null);
  const p = db.prepare("SELECT reserved_fen, spent_fen FROM budget_period WHERE period LIKE 'day:%'").get() as any;
  assert.equal(Number(p.reserved_fen), 50);
  assert.equal(Number(p.spent_fen), 0);
});

test('settle 幂等：二次结算不重复', () => {
  const { db, tracker } = makeTracker({ taskLimitFen: 100, dayLimitFen: 200, monthLimitFen: 500 });
  const { callId } = tracker.reserve(req());
  tracker.settle(callId, 'succeeded', 40);
  tracker.settle(callId, 'failed', 0);
  const p = db.prepare("SELECT reserved_fen, spent_fen FROM budget_period WHERE period LIKE 'day:%'").get() as any;
  assert.equal(Number(p.spent_fen), 40); // 第二次没有生效
});

test('日上限：达到即阻止', () => {
  const { tracker } = makeTracker({ taskLimitFen: 1000, dayLimitFen: 100, monthLimitFen: 5000 });
  tracker.reserve(req({ reservedFen: 80, taskId: 'a' }));
  assert.throws(() => tracker.reserve(req({ reservedFen: 30, taskId: 'b' })), /周期预算不足/);
});

test('任务级上限：同一任务累计、不同任务隔离', () => {
  const { tracker } = makeTracker({ taskLimitFen: 100, dayLimitFen: 5000, monthLimitFen: 5000 });
  tracker.reserve(req({ reservedFen: 80, taskId: 't1' }));
  assert.throws(() => tracker.reserve(req({ reservedFen: 30, taskId: 't1' })), /任务预算不足/);
  assert.doesNotThrow(() => tracker.reserve(req({ reservedFen: 30, taskId: 't2' })));
});

test('限额为 0（未授权）：任何预留都被拒绝', () => {
  const { tracker } = makeTracker({ taskLimitFen: 0, dayLimitFen: 0, monthLimitFen: 0 });
  assert.throws(() => tracker.reserve(req({ reservedFen: 1 })), (e: any) => e.code === 'BUDGET_BLOCKED');
  assert.throws(() => tracker.reserve(req({ reservedFen: 0 })), (e: any) => e.code === 'BUDGET_BLOCKED');
  assert.throws(() => tracker.reserve(req({ reservedFen: -5 })), (e: any) => e.code === 'BUDGET_BLOCKED');
});

test('必需限额非法（负数/非整数）被拒绝', () => {
  assert.throws(
    () => makeTracker({ taskLimitFen: -1, dayLimitFen: 200, monthLimitFen: 500 }).tracker.reserve(req()),
    (e: any) => e.code === 'BUDGET_BLOCKED'
  );
  assert.throws(
    () => makeTracker({ taskLimitFen: 1.5, dayLimitFen: 200, monthLimitFen: 500 }).tracker.reserve(req()),
    (e: any) => e.code === 'BUDGET_BLOCKED'
  );
});

test('预留金额必须为正的安全整数', () => {
  const { tracker } = makeTracker({ taskLimitFen: 100, dayLimitFen: 200, monthLimitFen: 500 });
  assert.throws(() => tracker.reserve(req({ reservedFen: 0 })), (e: any) => e.code === 'BUDGET_BLOCKED');
  assert.throws(() => tracker.reserve(req({ reservedFen: -5 })), (e: any) => e.code === 'BUDGET_BLOCKED');
  assert.throws(() => tracker.reserve(req({ reservedFen: 1.5 })), (e: any) => e.code === 'BUDGET_BLOCKED');
  assert.throws(() => tracker.reserve(req({ reservedFen: Number.MAX_SAFE_INTEGER + 1 })), (e: any) => e.code === 'BUDGET_BLOCKED');
});

test('NoopBudgetTracker 不预留、结算无副作用', () => {
  const t: BudgetTracker = new NoopBudgetTracker();
  const { callId } = t.reserve(req({ reservedFen: 1 }));
  assert.ok(callId.length > 0);
  assert.doesNotThrow(() => t.settle(callId, 'succeeded', 123));
});
