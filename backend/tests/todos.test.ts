import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { createRepo } from '../src/domain/repo.ts';
import { registerHealthRecord } from '../src/domain/records.ts';
import { computeTodos, weightStatus } from '../src/domain/todos.ts';
import { todayShanghai } from '../src/domain/time.ts';

function fresh() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, repo: createRepo(db) };
}
const cat = { role: 'mother', sex: null, birthDate: null, motherId: null, litterId: null } as const;
function addW(db: DatabaseSync, catId: string, date: string, g: number): void {
  db.prepare("INSERT INTO record(id,type,cat_id,business_date,weight_gram,created_at) VALUES(?, 'weight', ?, ?, ?, ?)").run(crypto.randomUUID(), catId, date, g, new Date().toISOString());
}

test('weightStatus：82→80 下降；82→80→81 回升仍低于 82；再 82 恢复', () => {
  assert.deepEqual(weightStatus([{ weightGram: 82 }, { weightGram: 80 }]), { status: '下降', latest: 80, previous: 82 });
  assert.deepEqual(weightStatus([{ weightGram: 82 }, { weightGram: 80 }, { weightGram: 81 }]), { status: '回升', latest: 81, previous: 80, baseline: 82 });
  assert.deepEqual(weightStatus([{ weightGram: 82 }, { weightGram: 80 }, { weightGram: 81 }, { weightGram: 82 }]), { status: '恢复', latest: 82, previous: 81 });
  assert.equal(weightStatus([{ weightGram: 82 }]).status, '无数据');
});

test('体重下降生成复称待办；回升后消失；三次记录保留', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  addW(db, 'c1', '2026-11-01', 82);
  addW(db, 'c1', '2026-11-02', 80);
  assert.equal(computeTodos(db).filter(t => t.type === 'weight_drop').length, 1);
  addW(db, 'c1', '2026-11-03', 81); // 复称回升但仍低于 82
  assert.equal(computeTodos(db).filter(t => t.type === 'weight_drop').length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n, 3);
});

test('物资不足与药品快过期', () => {
  const { db, repo } = fresh();
  repo.insertItem({ id: 'i1', name: '猫粮', category: 'food', quantity: 1, unit: '袋', priceFen: 4500, expiryDate: null });
  db.prepare("UPDATE item SET low_stock_threshold=2 WHERE id='i1'").run();
  assert.equal(computeTodos(db).filter(t => t.type === 'low_stock').length, 1);
  // 补货 → 消失
  db.prepare("UPDATE item SET quantity=5 WHERE id='i1'").run();
  assert.equal(computeTodos(db).filter(t => t.type === 'low_stock').length, 0);

  // 药品效期：数量 >0 且近效期才提醒；数量 0 不提醒
  repo.insertItem({ id: 'm1', name: '驱虫药', category: 'medicine', quantity: 3, unit: '支', priceFen: 1200, expiryDate: '2020-01-01' });
  repo.insertItem({ id: 'm2', name: '过期药(已用完)', category: 'medicine', quantity: 0, unit: '支', priceFen: 1200, expiryDate: '2020-01-01' });
  const expiring = computeTodos(db).filter(t => t.type === 'expiring');
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].itemId, 'm1');
});

test('驱虫/疫苗分别读最新记录，登记一种不清除另一种', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  db.prepare("INSERT INTO health_record(id,cat_id,type,date,next_due_date,created_at) VALUES('h1','c1','vaccine','2026-01-01','2020-01-01',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO health_record(id,cat_id,type,date,next_due_date,created_at) VALUES('h2','c1','deworm','2026-01-01','2020-01-01',?)").run(new Date().toISOString());
  assert.equal(computeTodos(db).filter(t => t.type === 'health_due').length, 2);
  registerHealthRecord(repo, { catId: 'c1', type: 'deworm', date: todayShanghai(), nextDueDate: '2099-01-01', note: null });
  const due = computeTodos(db).filter(t => t.type === 'health_due');
  assert.equal(due.length, 1);
  assert.equal(due[0].detail, '2020-01-01 到期'); // 只剩疫苗
});

test('待补充：needs_input 生成，完成后消失', () => {
  const { db, repo } = fresh();
  repo.insertInput({ id: 'inp0', textBody: 'x', state: 'needs_input', targetItemId: null, idempotencyKey: null });
  repo.insertIntentItem({ id: 'ii0', inputId: 'inp0', ordinal: 0, commandType: 'clarify', proposedPayload: '{}', state: 'needs_input', missingFields: '["catId"]', targetItemId: null });
  assert.equal(computeTodos(db).filter(t => t.type === 'needs_input').length, 1);
  repo.updateIntentItemState('ii0', 'completed');
  assert.equal(computeTodos(db).filter(t => t.type === 'needs_input').length, 0);
});

test('待办按优先级排序', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  addW(db, 'c1', '2026-11-01', 82);
  addW(db, 'c1', '2026-11-02', 80); // 🔴1
  repo.insertItem({ id: 'i1', name: '猫粮', category: 'food', quantity: 1, unit: '袋', priceFen: 4500, expiryDate: null });
  db.prepare("UPDATE item SET low_stock_threshold=2 WHERE id='i1'").run(); // 🟠2
  repo.insertInput({ id: 'inp0', textBody: 'x', state: 'needs_input', targetItemId: null, idempotencyKey: null });
  repo.insertIntentItem({ id: 'ii0', inputId: 'inp0', ordinal: 0, commandType: 'clarify', proposedPayload: '{}', state: 'needs_input', missingFields: '["catId"]', targetItemId: null }); // 🟡5
  const todos = computeTodos(db);
  const pri = todos.map(t => t.priority);
  assert.deepEqual(pri, [...pri].sort((a, b) => a - b));
  assert.equal(todos[0].type, 'weight_drop');
});
