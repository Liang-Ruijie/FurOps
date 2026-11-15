import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, validateItem, convertAmountFen } from '../src/domain/schema.ts';

test('parsePlan 接受对象与数组', () => {
  assert.equal(parsePlan({ items: [{ commandType: 'observation' }] }).ok, true);
  assert.equal(parsePlan([{ commandType: 'observation' }]).ok, true);
  assert.equal(parsePlan({}).ok, false);
  assert.equal(parsePlan(null).ok, false);
  assert.equal(parsePlan('x').ok, false);
});

test('convertAmountFen 金额换算', () => {
  assert.equal(convertAmountFen(30, '元'), 3000);
  assert.equal(convertAmountFen(3, '角'), 30);
  assert.equal(convertAmountFen(5, '分'), 5);
  assert.throws(() => convertAmountFen(0, '元'), /正整数/);
  assert.throws(() => convertAmountFen(-1, '元'), /正整数/);
  assert.equal(convertAmountFen(1.5, '元'), 150);
  assert.equal(convertAmountFen(0.29, '元'), 29);
  assert.throws(() => convertAmountFen(1.001, '元'), /正整数分/);
  assert.throws(() => convertAmountFen(1, '美元'), /元\/角\/分/);
});

test('validateItem：weight / expense / use_item', () => {
  assert.equal(validateItem({ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: 82 }).ok, true);
  assert.equal(validateItem({ commandType: 'weight', catId: 'c1', date: '2026-11-01' }).ok, false);
  assert.equal(validateItem({ commandType: 'weight', catId: 'c1', date: '2026-11-01', weightGram: -1 }).ok, false);

  assert.equal(validateItem({ commandType: 'expense', catId: 'c1', amount: 30, amountUnit: '元' }).ok, true);
  assert.equal(validateItem({ commandType: 'expense', catId: 'c1', amount: 30, amountUnit: '美元' }).ok, false);

  assert.equal(validateItem({ commandType: 'use_item', itemId: 'i1', catId: 'c1', quantity: 1 }).ok, true);
  assert.equal(validateItem({ commandType: 'use_item', itemId: 'i1', catId: 'c1', quantity: 0 }).ok, false);
});

test('validateItem：create_cat 小猫必须带 mother/litter；白名单外拒绝', () => {
  assert.equal(validateItem({ commandType: 'create_cat', name: '小红', role: 'kitten' }).ok, false);
  assert.equal(validateItem({ commandType: 'create_cat', name: '小红', role: 'kitten', motherId: 'm', litterId: 'l' }).ok, true);
  assert.equal(validateItem({ commandType: 'hack' }).ok, false);
});

test('validateItem：clarify 要求 missingFields 非空', () => {
  assert.equal(validateItem({ commandType: 'clarify', missingFields: [], question: '哪只猫？' }).ok, false);
  assert.equal(validateItem({ commandType: 'clarify', missingFields: ['catId'], question: '哪只猫？' }).ok, true);
});
