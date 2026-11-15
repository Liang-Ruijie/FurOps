import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.ts';
import { inTx } from './db.ts';
import { nowIso, uuid } from './auth.ts';

// 仓储层：任务租约/幂等 + 2-2 阶段业务数据读写（input/intent/record/cat/litter/item）
export interface Repo {
  // task（沿用 2-1）
  insertTask(row: { id: string; inputId: string | null; kind: string; state: string }): void;
  getTask(id: string): any;
  claimTask(workerId: string, leaseMs: number): any;
  completeTask(id: string, leaseToken: string, resultRef: string | null): void;
  failTask(id: string, leaseToken: string, errorCode: string): void;
  heartbeatTask(id: string, leaseToken: string, leaseMs: number): void;
  listTasks(): any[];
  transaction<T>(fn: () => T): T;

  // input_record
  insertInput(row: { id: string; textBody: string | null; state: string; targetItemId: string | null; idempotencyKey: string | null; boundCatId?: string | null; mediaIds?: string | null }): void;
  getInput(id: string): any;
  getInputByIdempotencyKey(key: string): any;
  updateInputState(id: string, state: string): void;

  // intent_item
  insertIntentItem(row: { id: string; inputId: string; ordinal: number; commandType: string | null; proposedPayload: string | null; state: string; missingFields: string | null; targetItemId: string | null }): void;
  getIntentItems(inputId: string): any[];
  getIntentItem(id: string): any;
  updateIntentItemState(id: string, state: string, missingFields?: string | null): void;
  hasIntentItems(inputId: string): boolean;

  // record
  insertRecord(row: { id: string; type: string; catId: string | null; itemId: string | null; businessDate: string; weightGram?: number | null; text?: string | null; amountFen?: number | null; quantity?: number | null; unitPriceFen?: number | null; reason?: string | null; sourceInputId?: string | null }): void;
  listRecentRecords(limit: number): any[];
  getRecord(id: string): any;
  updateRecordFields(id: string, version: number, fields: { weightGram?: number | null; text?: string | null; amountFen?: number | null; quantity?: number | null; reason?: string | null }): { changes: number | bigint };
  deleteRecordWithVersion(id: string, version: number): { changes: number | bigint };

  // cat / litter / item
  insertCat(row: { id: string; role: string; name: string; sex: string | null; birthDate: string | null; motherId: string | null; litterId: string | null }): void;
  getCat(id: string): any;
  listCatsByName(name: string): any[];
  listCats(limit: number): any[];
  insertLitter(row: { id: string; motherId: string; name: string | null; birthDate: string | null }): void;
  getLitter(id: string): any;
  listLitters(): any[];
  updateCatFields(id: string, version: number, fields: { name?: string | null; sex?: string | null; birthDate?: string | null; avatarPath?: string | null }): { changes: number | bigint };
  getItem(id: string): any;
  listItemsByName(name: string): any[];
  listItems(limit: number): any[];
  insertItem(row: { id: string; name: string; category: string; quantity: number; unit: string | null; priceFen: number | null; expiryDate: string | null }): void;
  updateItemQuantity(id: string, quantity: number): void;
  updateItemPrice(id: string, priceFen: number): void;
  updateItemFields(id: string, version: number, fields: { name?: string | null; category?: string | null; quantity?: number | null; unit?: string | null; priceFen?: number | null; expiryDate?: string | null; lowStockThreshold?: number | null }): { changes: number | bigint };
  insertHealthRecord(row: { id: string; catId: string; type: string; date: string; nextDueDate: string | null; note: string | null }): void;
  getLatestHealthRecord(catId: string, type: string): any;
  insertMedia(row: { id: string; relativePath: string; mime: string; byteSize: number }): void;
}

export function createRepo(db: DatabaseSync): Repo {
  return {
    transaction<T>(fn: () => T): T {
      return inTx(db, fn);
    },

    // ---------- task（沿用 2-1） ----------
    insertTask(row) {
      db.prepare('INSERT INTO task(id,input_id,kind,state,attempt,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
        .run(row.id, row.inputId, row.kind, row.state, nowIso(), nowIso());
    },
    getTask(id) {
      return db.prepare('SELECT * FROM task WHERE id=?').get(id);
    },
    claimTask(workerId, leaseMs) {
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      const now = nowIso();
      const task = db.prepare("SELECT id FROM task WHERE state='queued' OR (state='running' AND lease_until<?) ORDER BY created_at LIMIT 1")
        .get(now) as { id: string } | undefined;
      if (!task) return undefined;
      const token = uuid();
      let r: { changes: number | bigint };
      try {
        r = db.prepare("UPDATE task SET state='running', lease_token=?, lease_until=?, attempt=attempt+1, updated_at=? WHERE id=? AND (state='queued' OR (state='running' AND lease_until<?))")
          .run(token, leaseUntil, nowIso(), task.id, now);
      } catch (e) {
        if (/busy|locked/i.test(String((e as Error)?.message ?? e))) return undefined;
        throw e;
      }
      if (Number(r.changes) === 0) return undefined;
      return db.prepare('SELECT * FROM task WHERE id=?').get(task.id);
    },
    completeTask(id, leaseToken, resultRef) {
      const r = db.prepare("UPDATE task SET state='succeeded', result_ref=?, updated_at=? WHERE id=? AND lease_token=? AND state='running' AND lease_until>=?")
        .run(resultRef, nowIso(), id, leaseToken, nowIso());
      if (Number(r.changes) === 0) throw new AppError('DEPENDENCY', '任务租约已过期或状态已变', { nextAction: '迟到结果不得提交' });
    },
    failTask(id, leaseToken, errorCode) {
      const r = db.prepare("UPDATE task SET state='failed', error_code=?, updated_at=? WHERE id=? AND lease_token=? AND state='running' AND lease_until>=?")
        .run(errorCode, nowIso(), id, leaseToken, nowIso());
      if (Number(r.changes) === 0) throw new AppError('DEPENDENCY', '任务租约已过期或状态已变', { nextAction: '迟到结果不得提交' });
    },
    heartbeatTask(id, leaseToken, leaseMs) {
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      const r = db.prepare("UPDATE task SET lease_until=?, updated_at=? WHERE id=? AND lease_token=? AND state='running' AND lease_until>=?")
        .run(leaseUntil, nowIso(), id, leaseToken, nowIso());
      if (Number(r.changes) === 0) throw new AppError('DEPENDENCY', '任务租约已过期或状态已变', { nextAction: '过期租约不得续活' });
    },
    listTasks() {
      return db.prepare('SELECT * FROM task ORDER BY created_at DESC LIMIT 50').all();
    },

    // ---------- input_record ----------
    insertInput(row) {
      db.prepare('INSERT INTO input_record(id,text_body,state,target_item_id,idempotency_key,bound_cat_id,media_ids,captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.textBody, row.state, row.targetItemId, row.idempotencyKey, row.boundCatId ?? null, row.mediaIds ?? null, nowIso(), nowIso());
    },
    getInput(id) {
      return db.prepare('SELECT * FROM input_record WHERE id=?').get(id);
    },
    getInputByIdempotencyKey(key) {
      return db.prepare('SELECT * FROM input_record WHERE idempotency_key=?').get(key);
    },
    updateInputState(id, state) {
      db.prepare('UPDATE input_record SET state=?, updated_at=? WHERE id=?').run(state, nowIso(), id);
    },

    // ---------- intent_item ----------
    insertIntentItem(row) {
      db.prepare('INSERT INTO intent_item(id,input_id,ordinal,command_type,proposed_payload,state,missing_fields,target_item_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.inputId, row.ordinal, row.commandType, row.proposedPayload, row.state, row.missingFields ?? '[]', row.targetItemId, nowIso());
    },
    getIntentItems(inputId) {
      return db.prepare('SELECT * FROM intent_item WHERE input_id=? ORDER BY ordinal').all(inputId);
    },
    getIntentItem(id) {
      return db.prepare('SELECT * FROM intent_item WHERE id=?').get(id);
    },
    updateIntentItemState(id, state, missingFields) {
      db.prepare('UPDATE intent_item SET state=?, missing_fields=?, version=version+1 WHERE id=?').run(state, missingFields ?? '[]', id);
    },
    hasIntentItems(inputId) {
      const r = db.prepare('SELECT COUNT(*) n FROM intent_item WHERE input_id=?').get(inputId) as any;
      return Number(r.n) > 0;
    },

    // ---------- record ----------
    insertRecord(row) {
      db.prepare('INSERT INTO record(id,type,cat_id,item_id,business_date,weight_gram,text,amount_fen,quantity,unit_price_fen,reason,source_input_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.type, row.catId, row.itemId, row.businessDate, row.weightGram ?? null, row.text ?? null, row.amountFen ?? null, row.quantity ?? null, row.unitPriceFen ?? null, row.reason ?? null, row.sourceInputId ?? null, nowIso());
    },
    listRecentRecords(limit) {
      return db.prepare('SELECT * FROM record ORDER BY created_at DESC LIMIT ?').all(limit);
    },
    getRecord(id) {
      return db.prepare('SELECT * FROM record WHERE id=?').get(id);
    },
    updateRecordFields(id, version, fields) {
      const sets: string[] = []; const vals: any[] = [];
      if (fields.weightGram !== undefined) { sets.push('weight_gram=?'); vals.push(fields.weightGram); }
      if (fields.text !== undefined) { sets.push('text=?'); vals.push(fields.text); }
      if (fields.amountFen !== undefined) { sets.push('amount_fen=?'); vals.push(fields.amountFen); }
      if (fields.quantity !== undefined) { sets.push('quantity=?'); vals.push(fields.quantity); }
      if (fields.reason !== undefined) { sets.push('reason=?'); vals.push(fields.reason); }
      if (sets.length === 0) throw new AppError('SCHEMA_INVALID', '没有可更新的字段');
      vals.push(id, version);
      return db.prepare(`UPDATE record SET ${sets.join(', ')}, version=version+1 WHERE id=? AND version=?`).run(...vals);
    },
    deleteRecordWithVersion(id, version) {
      return db.prepare('DELETE FROM record WHERE id=? AND version=?').run(id, version);
    },

    // ---------- cat / litter / item ----------
    insertCat(row) {
      db.prepare('INSERT INTO cat(id,role,name,sex,birth_date,mother_id,litter_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.role, row.name, row.sex, row.birthDate, row.motherId, row.litterId, nowIso(), nowIso());
    },
    getCat(id) {
      return db.prepare('SELECT * FROM cat WHERE id=?').get(id);
    },
    listCatsByName(name) {
      return db.prepare('SELECT * FROM cat WHERE name=?').all(name);
    },
    listCats(limit) {
      return db.prepare('SELECT * FROM cat ORDER BY created_at LIMIT ?').all(limit);
    },
    insertLitter(row) {
      db.prepare('INSERT INTO litter(id,mother_id,name,birth_date,created_at) VALUES(?,?,?,?,?)')
        .run(row.id, row.motherId, row.name, row.birthDate, nowIso());
    },
    getLitter(id) {
      return db.prepare('SELECT * FROM litter WHERE id=?').get(id);
    },
    listLitters() {
      return db.prepare('SELECT * FROM litter ORDER BY created_at').all();
    },
    updateCatFields(id, version, fields) {
      const sets: string[] = []; const vals: any[] = [];
      if (fields.name !== undefined) { sets.push('name=?'); vals.push(fields.name); }
      if (fields.sex !== undefined) { sets.push('sex=?'); vals.push(fields.sex); }
      if (fields.birthDate !== undefined) { sets.push('birth_date=?'); vals.push(fields.birthDate); }
      if (fields.avatarPath !== undefined) { sets.push('avatar_path=?'); vals.push(fields.avatarPath); }
      if (sets.length === 0) throw new AppError('SCHEMA_INVALID', '没有可更新的字段');
      vals.push(nowIso(), id, version);
      return db.prepare(`UPDATE cat SET ${sets.join(', ')}, version=version+1, updated_at=? WHERE id=? AND version=?`).run(...vals);
    },
    getItem(id) {
      return db.prepare('SELECT * FROM item WHERE id=?').get(id);
    },
    listItemsByName(name) {
      return db.prepare('SELECT * FROM item WHERE name=?').all(name);
    },
    listItems(limit) {
      return db.prepare('SELECT * FROM item ORDER BY created_at LIMIT ?').all(limit);
    },
    insertItem(row) {
      db.prepare('INSERT INTO item(id,name,category,quantity,unit,price_fen,expiry_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.name, row.category, row.quantity, row.unit, row.priceFen, row.expiryDate, nowIso(), nowIso());
    },
    updateItemQuantity(id, quantity) {
      db.prepare('UPDATE item SET quantity=?, version=version+1, updated_at=? WHERE id=?').run(quantity, nowIso(), id);
    },
    updateItemPrice(id, priceFen) {
      db.prepare('UPDATE item SET price_fen=?, version=version+1, updated_at=? WHERE id=?').run(priceFen, nowIso(), id);
    },
    updateItemFields(id, version, fields) {
      const sets: string[] = []; const vals: any[] = [];
      if (fields.name !== undefined) { sets.push('name=?'); vals.push(fields.name); }
      if (fields.category !== undefined) { sets.push('category=?'); vals.push(fields.category); }
      if (fields.quantity !== undefined) { sets.push('quantity=?'); vals.push(fields.quantity); }
      if (fields.unit !== undefined) { sets.push('unit=?'); vals.push(fields.unit); }
      if (fields.priceFen !== undefined) { sets.push('price_fen=?'); vals.push(fields.priceFen); }
      if (fields.expiryDate !== undefined) { sets.push('expiry_date=?'); vals.push(fields.expiryDate); }
      if (fields.lowStockThreshold !== undefined) { sets.push('low_stock_threshold=?'); vals.push(fields.lowStockThreshold); }
      if (sets.length === 0) throw new AppError('SCHEMA_INVALID', '没有可更新的字段');
      vals.push(nowIso(), id, version);
      return db.prepare(`UPDATE item SET ${sets.join(', ')}, version=version+1, updated_at=? WHERE id=? AND version=?`).run(...vals);
    },
    insertHealthRecord(row) {
      db.prepare('INSERT INTO health_record(id,cat_id,type,date,next_due_date,note,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(row.id, row.catId, row.type, row.date, row.nextDueDate, row.note, nowIso());
    },
    getLatestHealthRecord(catId, type) {
      return db.prepare('SELECT * FROM health_record WHERE cat_id=? AND type=? ORDER BY date DESC, created_at DESC LIMIT 1').get(catId, type);
    },
    insertMedia(row) {
      db.prepare('INSERT INTO media(id,relative_path,mime,byte_size,created_at) VALUES(?,?,?,?,?)').run(row.id, row.relativePath, row.mime, row.byteSize, nowIso());
    },
  };
}

export function versionCheck(result: { changes: number | bigint }): void {
  if (Number(result.changes) === 0) throw new AppError('VERSION_CONFLICT', '记录已被其他操作修改，请核对', { retryable: false, nextAction: '重新加载并重试' });
}
