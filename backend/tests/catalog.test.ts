import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { createRepo } from '../src/domain/repo.ts';
import { createCat, editCat, createLitter, createItem, editItem } from '../src/domain/catalog.ts';
import { executeUseItem, executeCommand } from '../src/domain/records.ts';

function fresh() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, repo: createRepo(db) };
}

test('createCat：公/母不重复、小猫窝次必须属于所选母猫', () => {
  const { repo } = fresh();
  createCat(repo, { name: '红圈', role: 'mother', sex: '母', birthDate: null, motherId: null, litterId: null });
  assert.throws(() => createCat(repo, { name: '红圈', role: 'mother', sex: '母', birthDate: null, motherId: null, litterId: null }), (e: any) => e.code === 'SCHEMA_INVALID');
  createCat(repo, { name: '小白', role: 'mother', sex: '母', birthDate: null, motherId: null, litterId: null });
  const m1 = repo.listCatsByName('红圈')[0];
  const m2 = repo.listCatsByName('小白')[0];
  const l1 = createLitter(repo, { motherId: m1.id, name: '第一窝', birthDate: null });
  createCat(repo, { name: '小猫A', role: 'kitten', sex: null, birthDate: null, motherId: m1.id, litterId: l1.id });
  // 窝次属于红圈，却选小白 → 拒绝（避免关系错配）
  assert.throws(() => createCat(repo, { name: '小猫B', role: 'kitten', sex: null, birthDate: null, motherId: m2.id, litterId: l1.id }), (e: any) => e.code === 'SCHEMA_INVALID');
});

test('editCat：版本校验，旧版本不覆盖', () => {
  const { repo } = fresh();
  const { id } = createCat(repo, { name: '红圈', role: 'mother', sex: '母', birthDate: null, motherId: null, litterId: null });
  editCat(repo, id, { name: '红圈圈' }, 1);
  assert.throws(() => editCat(repo, id, { name: '红圈' }, 1), (e: any) => e.code === 'VERSION_CONFLICT');
});

test('createItem：数量非负、价格正整数', () => {
  const { repo } = fresh();
  assert.throws(() => createItem(repo, { name: '猫粮', category: 'food', quantity: -1, unit: '袋', priceFen: null, expiryDate: null, lowStockThreshold: null }), (e: any) => e.code === 'SCHEMA_INVALID');
  assert.throws(() => createItem(repo, { name: '猫粮', category: 'food', quantity: 1, unit: '袋', priceFen: -100, expiryDate: null, lowStockThreshold: null }), (e: any) => e.code === 'SCHEMA_INVALID');
  assert.doesNotThrow(() => createItem(repo, { name: '猫粮', category: 'food', quantity: 1, unit: '袋', priceFen: 4500, expiryDate: null, lowStockThreshold: 2 }));
});

test('editItem：版本校验 + 数量非负 + 改价不改历史费用', () => {
  const { db, repo } = fresh();
  const { id: itemId } = createItem(repo, { name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null, lowStockThreshold: null });
  repo.insertCat({ id: 'c1', role: 'mother', name: '雪地靴', sex: null, birthDate: null, motherId: null, litterId: null });
  executeUseItem(repo, { itemId, catId: 'c1', quantity: 1, unit: null }, null);
  const rec = db.prepare("SELECT unit_price_fen FROM record WHERE type='use_item'").get() as any;
  assert.equal(Number(rec.unit_price_fen), 1200);
  // 改价 + 改量（用当前版本）
  const curVersion = Number((db.prepare("SELECT version FROM item WHERE id=?").get(itemId) as any).version);
  editItem(repo, itemId, { priceFen: 2000, quantity: 6 }, curVersion);
  assert.equal(Number((db.prepare("SELECT price_fen FROM item WHERE id=?").get(itemId) as any).price_fen), 2000);
  const recAfter = db.prepare("SELECT unit_price_fen FROM record WHERE type='use_item'").get() as any;
  assert.equal(Number(recAfter.unit_price_fen), 1200); // 历史单价不变
  // 旧版本再改 → 冲突
  assert.throws(() => editItem(repo, itemId, { quantity: 3 }, curVersion), (e: any) => e.code === 'VERSION_CONFLICT');
  // 数量为负 → 拒绝
  assert.throws(() => editItem(repo, itemId, { quantity: -1 }, curVersion + 1), (e: any) => e.code === 'SCHEMA_INVALID');
});

test('用药/入库/更正删除同步递增物资版本，旧表单提交被拒', () => {
  const { db, repo } = fresh();
  const { id: itemId } = createItem(repo, { name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null, lowStockThreshold: null });
  repo.insertCat({ id: 'c1', role: 'mother', name: '雪地靴', sex: null, birthDate: null, motherId: null, litterId: null });
  const v0 = Number((db.prepare("SELECT version FROM item WHERE id=?").get(itemId) as any).version);
  // 用药扣库存 → 版本递增
  executeUseItem(repo, { itemId, catId: 'c1', quantity: 1, unit: null }, null);
  const v1 = Number((db.prepare("SELECT version FROM item WHERE id=?").get(itemId) as any).version);
  assert.equal(v1, v0 + 1);
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id=?").get(itemId) as any).quantity), 4);
  // 旧表单（version=v0）提交 → 拒绝，库存保持 4
  assert.throws(() => editItem(repo, itemId, { quantity: 5 }, v0), (e: any) => e.code === 'VERSION_CONFLICT');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id=?").get(itemId) as any).quantity), 4);
  // 入库也递增版本
  executeCommand(repo, { type: 'item_stock', payload: { itemId, name: null, quantity: 2, priceFen: null, expiryDate: null } }, null);
  const v2 = Number((db.prepare("SELECT version FROM item WHERE id=?").get(itemId) as any).version);
  assert.equal(v2, v1 + 1);
});
