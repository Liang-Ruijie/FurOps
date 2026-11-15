import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { SqliteBudgetTracker, NoopBudgetTracker } from '../src/domain/budget.ts';
import { MockPlanner, DeepSeekPlanner, type ModelTransport } from '../src/domain/planner.ts';

function memBudget(limits: { taskLimitFen: number; dayLimitFen: number; monthLimitFen: number }) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, budget: new SqliteBudgetTracker({ db, limits }) };
}

const okBody = { items: [{ commandType: 'observation', text: 'ok', date: '2026-11-01' }] };

test('MockPlanner 返回注入结果', async () => {
  const p = new MockPlanner(() => ({ items: [{ commandType: 'observation' }] }));
  const r = await p.plan({ text: 'x', context: {} });
  assert.deepEqual(r.items, [{ commandType: 'observation' }]);
});

test('DeepSeekPlanner 配 NoopBudgetTracker 拒绝构造（未授权）', () => {
  assert.throws(
    () => new DeepSeekPlanner({ apiKey: 'k', baseUrl: 'http://x', model: 'm', budget: new NoopBudgetTracker() }),
    (e: any) => e.code === 'BUDGET_BLOCKED'
  );
});

test('成功：reserve → settle succeeded，费用按 usage 结算', async () => {
  const { db, budget } = memBudget({ taskLimitFen: 1000, dayLimitFen: 5000, monthLimitFen: 5000 });
  const p = new DeepSeekPlanner({ apiKey: 'k', baseUrl: 'http://x', model: 'm', budget, transport: { send: async () => ({ status: 200, body: okBody, usageInput: 1000, usageOutput: 100 }) } });
  const r = await p.plan({ text: 'x', context: {} });
  assert.equal(r.items.length, 1);
  const mc = db.prepare('SELECT state, actual_fen FROM model_call').get() as any;
  assert.equal(mc.state, 'succeeded');
  assert.ok(Number(mc.actual_fen) >= 0);
});

test('结构非法：settle failed 且不重试', async () => {
  const { budget } = memBudget({ taskLimitFen: 1000, dayLimitFen: 5000, monthLimitFen: 5000 });
  let calls = 0;
  const p = new DeepSeekPlanner({ apiKey: 'k', baseUrl: 'http://x', model: 'm', budget, transport: { send: async () => { calls++; return { status: 200, body: { nope: true }, usageInput: 10, usageOutput: 10 }; } } });
  await assert.rejects(() => p.plan({ text: 'x', context: {} }), (e: any) => e.code === 'MODEL_TIMEOUT');
  assert.equal(calls, 1);
});

test('usage 缺失：settle unknown 且不重试', async () => {
  const { db, budget } = memBudget({ taskLimitFen: 1000, dayLimitFen: 5000, monthLimitFen: 5000 });
  const p = new DeepSeekPlanner({ apiKey: 'k', baseUrl: 'http://x', model: 'm', budget, transport: { send: async () => ({ status: 200, body: okBody, usageInput: NaN, usageOutput: NaN }) } });
  await assert.rejects(() => p.plan({ text: 'x', context: {} }));
  assert.equal((db.prepare('SELECT state FROM model_call').get() as any).state, 'unknown');
});

test('401/403：不重试', async () => {
  const { budget } = memBudget({ taskLimitFen: 1000, dayLimitFen: 5000, monthLimitFen: 5000 });
  let calls = 0;
  const p = new DeepSeekPlanner({ apiKey: 'k', baseUrl: 'http://x', model: 'm', budget, transport: { send: async () => { calls++; return { status: 401, body: null }; } } });
  await assert.rejects(() => p.plan({ text: 'x', context: {} }));
  assert.equal(calls, 1);
});

test('超时：settle unknown 不重试', async () => {
  const { db, budget } = memBudget({ taskLimitFen: 1000, dayLimitFen: 5000, monthLimitFen: 5000 });
  const slow: ModelTransport = { send: async () => { await new Promise(r => setTimeout(r, 200)); return { status: 200, body: okBody, usageInput: 1, usageOutput: 1 }; } };
  const p = new DeepSeekPlanner({ apiKey: 'k', baseUrl: 'http://x', model: 'm', budget, transport: slow, deadlineMs: 20 });
  await assert.rejects(() => p.plan({ text: 'x', context: {} }));
  assert.equal((db.prepare('SELECT state FROM model_call').get() as any).state, 'unknown');
});
