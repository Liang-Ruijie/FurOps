import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/domain/migrate.ts';
import { buildContext } from '../src/domain/memory.ts';

function iso(): string { return new Date().toISOString(); }

test('buildContext：取回候选猫、待补事项与接续目标', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO input_record(id,state,captured_at,updated_at) VALUES('inp0','needs_input',?,?)").run(iso(), iso());
  db.prepare("INSERT INTO cat(id,role,name,created_at,updated_at) VALUES('c1','mother','红圈',?,?)").run(iso(), iso());
  db.prepare("INSERT INTO intent_item(id,input_id,ordinal,state,missing_fields,created_at) VALUES('ii0','inp0',0,'needs_input','[\"catId\"]',?)").run(iso());

  const ctx = buildContext(db, '红圈', 'ii0');
  assert.equal(ctx.cats.length, 1);
  assert.equal(ctx.cats[0].name, '红圈');
  assert.equal(ctx.pendingItems.length, 1);
  assert.equal(ctx.targetItem?.id, 'ii0');
});

test('buildContext：无目标时 targetItem 为 null', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const ctx = buildContext(db, 'x', null);
  assert.equal(ctx.targetItem, null);
  assert.equal(ctx.cats.length, 0);
});

test('buildContext：targetItem 带回原输入、partialPayload、缺失字段', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO input_record(id,text_body,state,captured_at,updated_at) VALUES('inp0','红圈体重数字稍后补','needs_input',?,?)").run(iso(), iso());
  db.prepare("INSERT INTO intent_item(id,input_id,ordinal,command_type,proposed_payload,state,missing_fields,created_at) VALUES('ii0','inp0',0,'clarify','{\"missingFields\":[\"weightGram\"],\"question\":\"体重多少？\",\"partialPayload\":{\"commandType\":\"weight\",\"catId\":\"c1\"}}','needs_input','[\"weightGram\"]',?)").run(iso());
  const ctx = buildContext(db, '82克', 'ii0');
  assert.equal(ctx.targetItem?.originalInput, '红圈体重数字稍后补');
  assert.deepEqual(ctx.targetItem?.partialPayload, { commandType: 'weight', catId: 'c1' });
  assert.equal(ctx.targetItem?.commandType, 'clarify');
});
