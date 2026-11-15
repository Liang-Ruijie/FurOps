import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { createRepo } from '../src/domain/repo.ts';
import { executeCommand, executeUseItem, correctRecord, deleteRecord, registerHealthRecord } from '../src/domain/records.ts';

function fresh() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, repo: createRepo(db) };
}
const cat = { role: 'mother', sex: null, birthDate: null, motherId: null, litterId: null } as const;

test('weight：新增记录、不覆盖旧值', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  executeCommand(repo, { type: 'weight', payload: { catId: 'c1', date: '2026-11-01', weightGram: 82 } }, 'inp1');
  executeCommand(repo, { type: 'weight', payload: { catId: 'c1', date: '2026-11-02', weightGram: 80 } }, 'inp2');
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 2);
});

test('weight：猫不存在拒绝', () => {
  const { repo } = fresh();
  assert.throws(() => executeCommand(repo, { type: 'weight', payload: { catId: 'nope', date: '2026-11-01', weightGram: 82 } }, null), (e: any) => e.code === 'NOT_FOUND');
});

test('expense：记猫成本', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  executeCommand(repo, { type: 'expense', payload: { catId: 'c1', amountFen: 3000, reason: '药' } }, null);
  assert.equal(Number((db.prepare("SELECT amount_fen FROM record WHERE type='expense'").get() as any).amount_fen), 3000);
});

test('create_cat：公/母不重复建档', () => {
  const { repo } = fresh();
  executeCommand(repo, { type: 'create_cat', payload: { name: '红圈', role: 'mother', sex: null, birth: null, motherId: null, litterId: null } }, null);
  assert.throws(() => executeCommand(repo, { type: 'create_cat', payload: { name: '红圈', role: 'mother', sex: null, birth: null, motherId: null, litterId: null } }, null), (e: any) => e.code === 'SCHEMA_INVALID');
});

test('item_stock：新建物资入库', () => {
  const { db, repo } = fresh();
  executeCommand(repo, { type: 'item_stock', payload: { itemId: null, name: '猫粮', quantity: 2, priceFen: 4500, expiryDate: null } }, null);
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE name='猫粮'").get() as any).quantity), 2);
});

test('create_litter：母猫不存在拒绝', () => {
  const { repo } = fresh();
  assert.throws(() => executeCommand(repo, { type: 'create_litter', payload: { motherId: 'nope', birthDate: null, name: null } }, null), (e: any) => e.code === 'NOT_FOUND');
});

test('use_item：扣库存 + 单价快照 + 猫成本', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 1, unit: null }, 'inp1');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 4);
  const r = db.prepare("SELECT unit_price_fen, amount_fen FROM record WHERE type='use_item'").get() as any;
  assert.equal(Number(r.unit_price_fen), 1200);
  assert.equal(Number(r.amount_fen), 1200);
});

test('use_item：价格未知 → NEEDS_INPUT 不扣不记', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '新药', category: 'medicine', quantity: 5, unit: '支', priceFen: null, expiryDate: null });
  assert.throws(() => executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 1, unit: null }, null), (e: any) => e.code === 'NEEDS_INPUT');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 5);
  assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM record').get() as any).n), 0);
});

test('use_item：单位不一致 → NEEDS_INPUT 不猜换算', () => {
  const { repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  assert.throws(() => executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 1, unit: '盒' }, null), (e: any) => e.code === 'NEEDS_INPUT');
});

test('use_item：库存不足阻止（负库存保护）', () => {
  const { repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 1, unit: '支', priceFen: 1200, expiryDate: null });
  assert.throws(() => executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 2, unit: null }, null), (e: any) => e.code === 'SCHEMA_INVALID');
});

test('单价快照：改价不改历史，更正用量按原单价重算', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 2, unit: null }, 'inp1');
  repo.updateItemPrice('i1', 2000); // 改价
  const rec = db.prepare("SELECT id, version, unit_price_fen FROM record WHERE type='use_item'").get() as any;
  assert.equal(Number(rec.unit_price_fen), 1200); // 历史单价不变
  correctRecord(repo, rec.id, { quantity: 1 }, Number(rec.version));
  const rec2 = db.prepare('SELECT quantity, amount_fen, unit_price_fen FROM record WHERE id=?').get(rec.id) as any;
  assert.equal(Number(rec2.quantity), 1);
  assert.equal(Number(rec2.amount_fen), 1200); // 1 × 原单价
  assert.equal(Number(rec2.unit_price_fen), 1200);
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 4); // 5-2+1
});

test('更正入库导致负库存阻止', () => {
  const { db, repo } = fresh();
  executeCommand(repo, { type: 'item_stock', payload: { itemId: null, name: '驱虫药', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null } }, null);
  const item = db.prepare("SELECT id FROM item WHERE name='驱虫药'").get() as any;
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  executeUseItem(repo, { itemId: item.id, catId: 'c1', quantity: 4, unit: null }, null);
  const stockRec = db.prepare("SELECT id, version FROM record WHERE type='item_stock'").get() as any;
  assert.throws(() => correctRecord(repo, stockRec.id, { quantity: 2 }, Number(stockRec.version)), (e: any) => e.code === 'SCHEMA_INVALID');
});

test('删除 use_item：恢复库存、撤销成本', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 2, unit: null }, null);
  const rec = db.prepare("SELECT id, version FROM record WHERE type='use_item'").get() as any;
  deleteRecord(repo, rec.id, Number(rec.version));
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 5);
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='use_item'").get() as any).n), 0);
});

test('更正/删除版本校验：旧版本不覆盖、重复不重复调整库存', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 2, unit: null }, null);
  const rec = db.prepare("SELECT id, version FROM record WHERE type='use_item'").get() as any;
  correctRecord(repo, rec.id, { quantity: 1 }, Number(rec.version));
  assert.throws(() => correctRecord(repo, rec.id, { quantity: 1 }, Number(rec.version)), (e: any) => e.code === 'VERSION_CONFLICT');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 4); // 5-2+1，未被二次调整
});

test('更正入口字段合法性：负数/错误类型被拒绝，记录/库存/成本不变', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  executeUseItem(repo, { itemId: 'i1', catId: 'c1', quantity: 2, unit: null }, null);
  const rec = db.prepare("SELECT id, version, quantity, amount_fen FROM record WHERE type='use_item'").get() as any;
  assert.throws(() => correctRecord(repo, rec.id, { quantity: -1 }, Number(rec.version)), (e: any) => e.code === 'SCHEMA_INVALID');
  assert.throws(() => correctRecord(repo, rec.id, { quantity: 'abc' as any }, Number(rec.version)), (e: any) => e.code === 'SCHEMA_INVALID');
  assert.throws(() => correctRecord(repo, rec.id, { amountFen: -1200 }, Number(rec.version)), (e: any) => e.code === 'SCHEMA_INVALID');
  // 拒绝后：记录、库存、成本均不变
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 3);
  const rec2 = db.prepare('SELECT quantity, amount_fen FROM record WHERE id=?').get(rec.id) as any;
  assert.equal(Number(rec2.quantity), 2);
  assert.equal(Number(rec2.amount_fen), 2400);
});

test('登记健康记录：驱虫/疫苗、type 校验、猫不存在拒绝', () => {
  const { repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  registerHealthRecord(repo, { catId: 'c1', type: 'deworm', date: '2026-11-01', nextDueDate: '2026-12-01', note: null });
  assert.throws(() => registerHealthRecord(repo, { catId: 'c1', type: 'bad', date: '2026-11-01', nextDueDate: null, note: null }), (e: any) => e.code === 'SCHEMA_INVALID');
  assert.throws(() => registerHealthRecord(repo, { catId: 'nope', type: 'vaccine', date: '2026-11-01', nextDueDate: null, note: null }), (e: any) => e.code === 'NOT_FOUND');
});
