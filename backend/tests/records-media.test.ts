import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/domain/migrate.ts';
import { createRepo } from '../src/domain/repo.ts';
import { listRecords, correctRecord } from '../src/domain/records.ts';
import { saveMedia } from '../src/domain/media.ts';

function fresh() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, repo: createRepo(db) };
}
const cat = { role: 'mother', sex: null, birthDate: null, motherId: null, litterId: null } as const;

test('listRecords：筛选类型并关联猫名', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  repo.insertRecord({ id: 'r1', type: 'weight', catId: 'c1', itemId: null, businessDate: '2026-11-01', weightGram: 82 });
  repo.insertRecord({ id: 'r2', type: 'expense', catId: 'c1', itemId: null, businessDate: '2026-11-02', amountFen: 3000 });
  const weights = listRecords(db, { type: 'weight' });
  assert.equal(weights.length, 1);
  assert.equal(weights[0].catName, '红圈');
  assert.equal(weights[0].weightGram, 82);
});

test('saveMedia：校验类型/大小、入库；input 携带 mediaIds', () => {
  const { repo } = fresh();
  const tmp = mkdtempSync(join(tmpdir(), 'furops-media-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = tmp;
  try {
    const { id, relativePath } = saveMedia(repo, { mime: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRcsAAAAASUVORK5CYII=', 'base64') });
    assert.ok(id);
    assert.match(relativePath, /^media\/.+\.png$/);
    assert.throws(() => saveMedia(repo, { mime: 'text/plain', bytes: new Uint8Array([1]) }), (e: any) => e.code === 'FILE_TYPE');
    assert.throws(() => saveMedia(repo, { mime: 'image/png', bytes: new Uint8Array(11 * 1024 * 1024) }), (e: any) => e.code === 'FILE_LIMIT');
    repo.insertInput({ id: 'inp1', textBody: 'x', state: 'received', targetItemId: null, idempotencyKey: null, mediaIds: JSON.stringify([id]) });
    assert.equal(repo.getInput('inp1').media_ids, JSON.stringify([id]));
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('更正记录后返回层可 JSON 序列化（无 BigInt），观察/体重/费用/用药/入库均覆盖', () => {
  const { db, repo } = fresh();
  repo.insertCat({ id: 'c1', name: '红圈', ...cat });
  repo.insertItem({ id: 'i1', name: '驱虫药', category: 'medicine', quantity: 5, unit: '支', priceFen: 1200, expiryDate: null });
  repo.insertRecord({ id: 'r1', type: 'weight', catId: 'c1', itemId: null, businessDate: '2026-11-01', weightGram: 82 });
  repo.insertRecord({ id: 'r2', type: 'observation', catId: 'c1', itemId: null, businessDate: '2026-11-01', text: '精神不错' });
  repo.insertRecord({ id: 'r3', type: 'expense', catId: 'c1', itemId: null, businessDate: '2026-11-01', amountFen: 3000 });
  repo.insertRecord({ id: 'r4', type: 'use_item', catId: 'c1', itemId: 'i1', businessDate: '2026-11-01', quantity: 1, unitPriceFen: 1200, amountFen: 1200 });
  repo.insertRecord({ id: 'r5', type: 'item_stock', catId: null, itemId: 'i1', businessDate: '2026-11-01', quantity: 5 });
  correctRecord(repo, 'r1', { weightGram: 85 }, 1);
  correctRecord(repo, 'r2', { text: '精神很好' }, 1);
  correctRecord(repo, 'r3', { amountFen: 2500 }, 1);
  correctRecord(repo, 'r4', { quantity: 1 }, 1);
  correctRecord(repo, 'r5', { quantity: 5 }, 1);
  const rows = listRecords(db, {});
  assert.equal(rows.length, 5);
  assert.doesNotThrow(() => JSON.stringify(rows)); // 返回层可序列化，无 BigInt
  const w = rows.find(r => r.id === 'r1');
  assert.equal(w?.weightGram, 85);
  const o = rows.find(r => r.id === 'r2');
  assert.equal(o?.text, '精神很好');
});


test('saveMedia rejects spoofed PNG content without creating an attachment', () => {
  const { db, repo } = fresh();
  assert.throws(() => saveMedia(repo, { mime: 'image/png', bytes: new Uint8Array([1,2,3]) }), (e: any) => e.code === 'FILE_TYPE');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get()?.n, 0);
});


test('超过200条记录仍能完整列出并按筛选分页展示，不截断旧记录', () => {
  const {db,repo}=fresh();
  repo.insertCat({id:'c1',name:'分页验收猫',...cat});
  for(let i=0;i<205;i++)repo.insertRecord({id:'page-'+i,type:'weight',catId:'c1',itemId:null,businessDate:'2026-11-01',weightGram:200+i});
  const rows=listRecords(db,{});
  assert.equal(rows.length,205);
  assert.equal(new Set(rows.map(r=>r.id)).size,205);
  assert.equal(rows.slice(200,210).length,5);
  assert.equal(listRecords(db,{type:'weight',catId:'c1'}).length,205);
  assert.equal(listRecords(db,{dateFrom:'2026-11-02'}).length,0);
});
