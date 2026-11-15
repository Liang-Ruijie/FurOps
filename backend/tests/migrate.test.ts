import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';

const EXPECTED_TABLES = [
  'app_config', 'budget_period', 'cat', 'health_record', 'input_record',
  'intent_item', 'item', 'litter', 'media', 'model_call', 'record', 'task',
];

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(r => r.name);
}

test('迁移建齐 12 张表', () => {
  const db = new DatabaseSync(':memory:');
  const n = migrate(db);
  assert.equal(n, 12);
  assert.deepEqual(tableNames(db), EXPECTED_TABLES);
});

test('迁移幂等：重复执行不报错', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.doesNotThrow(() => migrate(db));
  assert.deepEqual(tableNames(db), EXPECTED_TABLES);
});

test('关键列抽查：task 有租约列、model_call 有预算列', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const taskCols = (db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>).map(c => c.name);
  for (const c of ['id', 'input_id', 'kind', 'state', 'lease_token', 'lease_until', 'attempt', 'result_ref', 'error_code']) {
    assert.ok(taskCols.includes(c), `task 缺列 ${c}`);
  }
  const mcCols = (db.prepare('PRAGMA table_info(model_call)').all() as Array<{ name: string }>).map(c => c.name);
  for (const c of ['task_id', 'provider', 'model_name', 'capability', 'state', 'reserved_fen', 'actual_fen', 'error_code']) {
    assert.ok(mcCols.includes(c), `model_call 缺列 ${c}`);
  }
  const bpCols = (db.prepare('PRAGMA table_info(budget_period)').all() as Array<{ name: string }>).map(c => c.name);
  for (const c of ['period', 'provider', 'limit_fen', 'reserved_fen', 'spent_fen']) {
    assert.ok(bpCols.includes(c), `budget_period 缺列 ${c}`);
  }
});
