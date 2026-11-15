import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { createRepo } from '../src/domain/repo.ts';
import { createService } from '../src/domain/service.ts';
import { MockPlanner } from '../src/domain/planner.ts';
import type { Repo } from '../src/domain/repo.ts';

const cat = { role: 'mother', sex: null, birthDate: null, motherId: null, litterId: null } as const;

function fresh(items: Array<Record<string, unknown>>) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const repo = createRepo(db);
  const planner = new MockPlanner(() => ({ items }));
  const service = createService(db, repo, planner);
  return { db, repo, service };
}

test('submit 幂等：同 idempotencyKey 只存一笔', () => {
  const { service } = fresh([]);
  const a = service.submit({ text: '红圈82克', idempotencyKey: 'k1' });
  const b = service.submit({ text: '红圈82克', idempotencyKey: 'k1' });
  assert.equal(a.id, b.id);
  assert.equal(b.replayed, true);
});

test('processInput：weight 入档并 completed', async () => {
  const { db, repo, service } = fresh([{ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: 82 }]);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  const { id } = service.submit({ text: '红圈82克' });
  const state = await service.processInput(id);
  assert.equal(state, 'completed');
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 1);
});

test('use_item：扣库存并 completed', async () => {
  const { db, repo, service } = fresh([{ commandType: 'use_item', itemId: 'i1', catId: 'c1', quantity: 1 }]);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  const { id } = service.submit({ text: '用1支驱虫药' });
  const state = await service.processInput(id);
  assert.equal(state, 'completed');
  assert.equal((db.prepare('SELECT state FROM intent_item WHERE input_id=?').get(id) as any).state, 'completed');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 4); // 已扣
});

test('use_item：价格未知 → needs_input 不扣库存', async () => {
  const { db, repo, service } = fresh([{ commandType: 'use_item', itemId: 'i1', catId: 'c1', quantity: 1 }]);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  repo.insertItem({ id: 'i1', name: '新药', category: 'medicine', quantity: 5, unit: '支', priceFen: null, expiryDate: null });
  const { id } = service.submit({ text: '用1支新药' });
  const state = await service.processInput(id);
  assert.equal(state, 'needs_input');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 5);
});

test('遗留 pending 用药意图接续执行且只执行一次', async () => {
  const { db, repo, service } = fresh([]);
  repo.insertCat({ id: 'c1', name: '雪地靴', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  repo.insertInput({ id: 'inp0', textBody: '用1支驱虫药', state: 'pending', targetItemId: null, idempotencyKey: null });
  repo.insertIntentItem({ id: 'ii0', inputId: 'inp0', ordinal: 0, commandType: 'use_item', proposedPayload: JSON.stringify({ itemId: 'i1', catId: 'c1', quantity: 1, unit: null }), state: 'pending', missingFields: null, targetItemId: null });
  const state = await service.processInput('inp0');
  assert.equal(state, 'completed');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 4);
  await service.processInput('inp0');
  assert.equal(Number((db.prepare("SELECT quantity FROM item WHERE id='i1'").get() as any).quantity), 4); // 只执行一次
});

test('事件绑定：绑定猫后输入数字记到该猫；自由输入无绑定不记', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const repo = createRepo(db);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  const planner = new MockPlanner(({ text, context }) => {
    const bound = (context as any).boundCat;
    const m = text.match(/\d+/);
    if (bound && m) return { items: [{ commandType: 'weight', catId: bound.id, date: '2026-11-01', weightGram: Number(m[0]) }] };
    return { items: [] };
  });
  const service = createService(db, repo, planner);
  const { id } = service.submit({ text: '81克', boundCatId: 'c1' });
  assert.equal(await service.processInput(id), 'completed');
  const rec = db.prepare("SELECT cat_id, weight_gram FROM record WHERE type='weight'").get() as any;
  assert.equal(rec.cat_id, 'c1');
  assert.equal(Number(rec.weight_gram), 81);
  const { id: id2 } = service.submit({ text: '81克' }); // 自由输入无绑定
  await service.processInput(id2);
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 1);
});

test('整理失败重试：原任务重处理，不重新提交', async () => {
  const { db, repo, service } = fresh([{ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: 82 }]);
  const { id } = service.submit({ text: '红圈82克' });
  let state = await service.processInput(id); // 未建猫 → 失败
  assert.equal(state, 'failed');
  repo.insertCat({ id: 'c1', name: '红圈', ...cat }); // 补建猫
  assert.equal(await service.retryInput(id), 'received');
  state = await service.processInput(id);
  assert.equal(state, 'completed');
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 1);
});

test('补充接续：targetItemId 持久保存并回填新意图', async () => {
  const { db, repo, service } = fresh([{ commandType: 'observation', text: '补充', date: '2026-11-01' }]);
  repo.insertInput({ id: 'inp0', textBody: 'x', state: 'needs_input', targetItemId: null, idempotencyKey: null });
  repo.insertIntentItem({ id: 'ii0', inputId: 'inp0', ordinal: 0, commandType: 'clarify', proposedPayload: '{}', state: 'needs_input', missingFields: '["catId"]', targetItemId: null });
  const { id } = service.submit({ text: '补充', targetItemId: 'ii0' });
  assert.equal((db.prepare('SELECT target_item_id FROM input_record WHERE id=?').get(id) as any).target_item_id, 'ii0');
  await service.processInput(id);
  const it = db.prepare('SELECT target_item_id, state FROM intent_item WHERE input_id=?').get(id) as any;
  assert.equal(it.target_item_id, 'ii0');
});

test('重启续跑：已完成意图不重复入档', async () => {
  const { db, repo, service } = fresh([{ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: 82 }]);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  const { id } = service.submit({ text: '红圈82克' });
  await service.processInput(id);
  const state2 = await service.processInput(id); // 模拟重启后重跑
  assert.equal(state2, 'completed');
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 1);
});

test('clarify：输入转为 needs_input', async () => {
  const { db, service } = fresh([{ commandType: 'clarify', missingFields: ['catId'], question: '哪只猫？' }]);
  const { id } = service.submit({ text: '81克' });
  const state = await service.processInput(id);
  assert.equal(state, 'needs_input');
  assert.equal((db.prepare('SELECT state FROM intent_item WHERE input_id=?').get(id) as any).state, 'needs_input');
});

test('幂等冲突：同 key 不同内容报冲突', () => {
  const { service } = fresh([]);
  service.submit({ text: '红圈82克', idempotencyKey: 'k1' });
  assert.throws(() => service.submit({ text: '别的文字', idempotencyKey: 'k1' }), (e: any) => e.code === 'IDEMPOTENCY_CONFLICT');
});

test('补充接回：完成后同步结束原待补事项', async () => {
  const { db, repo, service } = fresh([{ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: 82 }]);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  repo.insertInput({ id: 'inp0', textBody: '复称红圈', state: 'needs_input', targetItemId: null, idempotencyKey: null });
  repo.insertIntentItem({ id: 'ii0', inputId: 'inp0', ordinal: 0, commandType: 'clarify', proposedPayload: '{}', state: 'needs_input', missingFields: '["catId"]', targetItemId: null });
  const { id } = service.submit({ text: '82克', targetItemId: 'ii0' });
  const state = await service.processInput(id);
  assert.equal(state, 'completed');
  assert.equal((db.prepare("SELECT state FROM intent_item WHERE id='ii0'").get() as any).state, 'completed');
  assert.equal((db.prepare("SELECT state FROM input_record WHERE id='inp0'").get() as any).state, 'completed');
});

test('写入与状态一致：状态更新异常时记录回滚、不重复', async () => {
  const items = [{ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: 82 }];
  const { db, repo } = fresh(items);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  // 包装 repo：标记 completed 时抛错（模拟记录写入后状态更新异常）
  const faulty = {
    ...repo,
    updateIntentItemState(id: string, state: string, mf?: string | null) {
      if (state === 'completed') throw new Error('simulated failure after record write');
      return repo.updateIntentItemState(id, state, mf);
    },
  } as Repo;
  const svc = createService(db, faulty, new MockPlanner(() => ({ items })));
  const { id } = svc.submit({ text: '红圈82克' });
  const state = await svc.processInput(id);
  assert.equal(state, 'failed');
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 0);
  await svc.processInput(id);
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM record WHERE type='weight'").get() as any).n), 0);
});

test('补充接回已知对象：先"红圈体重稍后补"再"82克"接回红圈', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const repo = createRepo(db);
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  repo.insertInput({ id: 'inp0', textBody: '红圈体重数字稍后补', state: 'needs_input', targetItemId: null, idempotencyKey: null });
  repo.insertIntentItem({ id: 'ii0', inputId: 'inp0', ordinal: 0, commandType: 'clarify', proposedPayload: JSON.stringify({ missingFields: ['weightGram'], question: '体重多少？', partialPayload: { commandType: 'weight', catId: 'c1' } }), state: 'needs_input', missingFields: '["weightGram"]', targetItemId: null });
  // mock 规划器：从 targetItem.partialPayload 接回猫，从文本提取数字
  const planner = new MockPlanner(({ text, context }) => {
    const target = (context as any).targetItem;
    const catId = target?.partialPayload?.catId ?? null;
    const m = text.match(/\d+/);
    return { items: [{ commandType: 'weight', catId, date: '2026-11-01', weightGram: Number(m?.[0] ?? 82) }] };
  });
  const service = createService(db, repo, planner);
  const { id } = service.submit({ text: '82克', targetItemId: 'ii0' });
  const state = await service.processInput(id);
  assert.equal(state, 'completed');
  const rec = db.prepare("SELECT cat_id, weight_gram FROM record WHERE type='weight'").get() as any;
  assert.equal(rec.cat_id, 'c1');
  assert.equal(Number(rec.weight_gram), 82);
  assert.equal((db.prepare("SELECT state FROM intent_item WHERE id='ii0'").get() as any).state, 'completed');
});
