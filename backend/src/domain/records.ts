import { AppError } from './errors.ts';
import { uuid } from './auth.ts';
import type { Repo } from './repo.ts';
import type { Command } from './schema.ts';
import type { DatabaseSync } from 'node:sqlite';
import { todayShanghai, validDate } from './time.ts';

function today(): string {
  return todayShanghai();
}

// 执行一个已通过结构校验的命令（存在性/业务校验在此做；use_item 与 clarify 不在这里执行，由 service 处理）
export function executeCommand(repo: Repo, cmd: Command, sourceInputId: string | null): void {
  const p = cmd.payload as Record<string, any>;

  switch (cmd.type) {
    case 'weight': {
      const catId = p.catId as string;
      const date = p.date as string;
      const weightGram = p.weightGram as number;
      if (!repo.getCat(catId)) throw new AppError('NOT_FOUND', '猫咪不存在，请先建档或 clarify');
      if (!validDate(date)||date > today()) throw new AppError('SCHEMA_INVALID', '体重日期不能晚于今天');
      repo.insertRecord({ id: uuid(), type: 'weight', catId, itemId: null, businessDate: date, weightGram, sourceInputId });
      return;
    }
    case 'observation': {
      const catId = (p.catId as string | null) ?? null;
      const date = (p.date as string) ?? today();
      const text = p.text as string;
      if(!validDate(date)||date>today())throw new AppError('SCHEMA_INVALID','观察日期必须是今天或过去的有效日期');
      if (catId && !repo.getCat(catId)) throw new AppError('NOT_FOUND', '猫咪不存在');
      repo.insertRecord({ id: uuid(), type: 'observation', catId, itemId: null, businessDate: date, text, sourceInputId });
      return;
    }
    case 'expense': {
      const catId = p.catId as string;
      const amountFen = p.amountFen as number;
      const reason = (p.reason as string) ?? '';
      if (!repo.getCat(catId)) throw new AppError('NOT_FOUND', '猫咪不存在');
      repo.insertRecord({ id: uuid(), type: 'expense', catId, itemId: null, businessDate: today(), amountFen, reason, sourceInputId });
      return;
    }
    case 'item_stock': {
      const itemId = (p.itemId as string | null) ?? null;
      const name = (p.name as string | null) ?? null;
      const quantity = p.quantity as number;
      const priceFen = (p.priceFen as number | null) ?? null;
      const expiryDate = (p.expiryDate as string | null) ?? null;
      const unit=(p.unit as string|null)??null;
      if (itemId) {
        const item = repo.getItem(itemId);
        if (!item) throw new AppError('NOT_FOUND', '物资不存在');
        if(unit&&item.unit&&unit!==item.unit)throw new AppError('NEEDS_INPUT','到货单位与物资单位不同，请核对',{details:[{field:'unit',reason:'unit_mismatch'}]});
        repo.updateItemQuantity(itemId, Number(item.quantity) + quantity);
        if (priceFen != null && item.price_fen == null) repo.updateItemPrice(itemId, priceFen);
        repo.insertRecord({ id: uuid(), type: 'item_stock', itemId, catId: null, businessDate: today(), quantity, sourceInputId });
      } else {
        const id = uuid();
        repo.insertItem({ id, name: name as string, category: 'other', quantity, unit, priceFen, expiryDate });
        repo.insertRecord({ id: uuid(), type: 'item_stock', itemId: id, catId: null, businessDate: today(), quantity, sourceInputId });
      }
      return;
    }
    case 'create_cat': {
      const name = p.name as string;
      const role = p.role as string;
      const sex = (p.sex as string | null) ?? null;
      const birth = (p.birth as string | null) ?? null;
      const motherId = (p.motherId as string | null) ?? null;
      const litterId = (p.litterId as string | null) ?? null;
      if(birth&&(!validDate(birth)||birth>today()))throw new AppError('SCHEMA_INVALID','出生日期无效');
      if (role === 'kitten') {
        const mother=motherId?repo.getCat(motherId):null;const litter=litterId?repo.getLitter(litterId):null;
        if(!mother||mother.role!=='mother')throw new AppError('SCHEMA_INVALID','所属母猫必须是有效母猫档案');
        if(!litter||litter.mother_id!==motherId)throw new AppError('SCHEMA_INVALID','窝次不属于所选母猫');
      } else {
        const dup = repo.listCatsByName(name).filter(c => c.role === 'male' || c.role === 'mother');
        if (dup.length > 0) throw new AppError('SCHEMA_INVALID', `已存在同名公/母猫「${name}」，不重复建档`);
      }
      repo.insertCat({ id: uuid(), role, name, sex, birthDate: birth, motherId, litterId });
      return;
    }
    case 'create_litter': {
      const motherId = p.motherId as string;
      const birthDate = (p.birthDate as string | null) ?? null;
      const name = (p.name as string | null) ?? null;
      if (!repo.getCat(motherId))throw new AppError('NOT_FOUND','母猫不存在');
      if (repo.getCat(motherId)?.role!=='mother') throw new AppError('SCHEMA_INVALID', '所属档案必须是母猫');
      if(birthDate&&(!validDate(birthDate)||birthDate>today()))throw new AppError('SCHEMA_INVALID','出生日期无效');
      repo.insertLitter({ id: uuid(), motherId, name, birthDate });
      return;
    }
    default:
      throw new AppError('SCHEMA_INVALID', `命令 ${cmd.type} 不在此阶段执行`);
  }
}

// 登记健康记录（驱虫/疫苗 + 下次到期日），消除 🟡4 待办
export function registerHealthRecord(repo: Repo, payload: { catId: string; type: string; date: string; nextDueDate: string | null; note: string | null }): void {
  if (!['vaccine', 'deworm'].includes(payload.type)) throw new AppError('SCHEMA_INVALID', 'type 必须是 vaccine/deworm');
  const cat=repo.getCat(payload.catId);
  if(!cat)throw new AppError('NOT_FOUND','猫咪不存在');
  if(!validDate(payload.date)||payload.date>today())throw new AppError('SCHEMA_INVALID','完成日期必须是今天或过去的有效日期');
  if(payload.nextDueDate&&(!validDate(payload.nextDueDate)||payload.nextDueDate<payload.date))throw new AppError('SCHEMA_INVALID','下次日期不能早于完成日期');
  if(cat.birth_date){
    if(payload.date<cat.birth_date)throw new AppError('SCHEMA_INVALID','完成日期不能早于出生日期');
    if(cat.role==='kitten'){const age=(Date.parse(payload.date)-Date.parse(cat.birth_date))/86400000;const minimum=payload.type==='vaccine'?52:45;if(age<minimum)throw new AppError('SCHEMA_INVALID',`按本猫舍约定，幼猫${payload.type==='vaccine'?'首针疫苗不早于52':'驱虫不早于45'}日龄，日期需要核对`);}
  }
  repo.insertHealthRecord({ id: uuid(), catId: payload.catId, type: payload.type, date: payload.date, nextDueDate: payload.nextDueDate, note: payload.note });
}

// 事件记录列表（服务端筛选；BigInt 转 Number；关联猫/物资名）
export function listRecords(db: DatabaseSync, filter: { type?: string; catId?: string; dateFrom?: string; dateTo?: string }): Array<Record<string, unknown>> {
  const conds: string[] = []; const vals: any[] = [];
  if (filter.type) { conds.push('r.type=?'); vals.push(filter.type); }
  if (filter.catId) { conds.push('r.cat_id=?'); vals.push(filter.catId); }
  if (filter.dateFrom) { conds.push('r.business_date>=?'); vals.push(filter.dateFrom); }
  if (filter.dateTo) { conds.push('r.business_date<=?'); vals.push(filter.dateTo); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(`SELECT r.id, r.type, r.cat_id AS catId, r.item_id AS itemId, r.business_date AS businessDate, r.weight_gram AS weightGram, r.text, r.amount_fen AS amountFen, r.quantity, r.unit_price_fen AS unitPriceFen, r.reason, r.version, ir.media_ids AS mediaIds, c.name AS catName, i.name AS itemName, i.unit AS itemUnit FROM record r LEFT JOIN input_record ir ON ir.id=r.source_input_id LEFT JOIN cat c ON c.id=r.cat_id LEFT JOIN item i ON i.id=r.item_id ${where} ORDER BY r.business_date DESC, r.created_at DESC, r.id DESC`).all(...vals) as Array<any>;
  return rows.map(r => ({
    ...r,
    mediaIds: r.mediaIds ? JSON.parse(r.mediaIds) : [],
    weightGram: r.weightGram != null ? Number(r.weightGram) : null,
    amountFen: r.amountFen != null ? Number(r.amountFen) : null,
    quantity: r.quantity != null ? Number(r.quantity) : null,
    unitPriceFen: r.unitPriceFen != null ? Number(r.unitPriceFen) : null,
    version: Number(r.version),
  }));
}

// 用药执行：扣库存 + 单价快照 + 猫成本（价格未知/单位不一致 → NEEDS_INPUT 补问）
export function executeUseItem(repo: Repo, payload: Record<string, any>, sourceInputId: string | null): void {
  const itemId = payload.itemId as string;
  const catId = payload.catId as string;
  const quantity = payload.quantity as number;
  const unit = (payload.unit as string | null) ?? null;

  const item = repo.getItem(itemId);
  if (!item) throw new AppError('NOT_FOUND', '物资不存在');
  if (!repo.getCat(catId)) throw new AppError('NOT_FOUND', '猫咪不存在');

  // 单位核对（服务端二次校验，不依赖模型）：单位不一致先补问，不猜换算
  if (unit && item.unit && unit !== item.unit) {
    throw new AppError('NEEDS_INPUT', `单位不一致：物资按「${item.unit}」计，请确认换算`, { details: [{ field: 'quantity', reason: 'unit_mismatch' }] });
  }
  if(!item.unit)throw new AppError('NEEDS_INPUT','物资计量单位未登记，请先在电脑物资卡片确认',{details:[{field:'unit',reason:'unit_unknown'}]});
  if(item.price_fen!=null&&payload.priceFen!=null&&Number(item.price_fen)!==Number(payload.priceFen))throw new AppError('NEEDS_INPUT','本次单价与物资卡片不同，请先在电脑核对单价',{details:[{field:'price',reason:'price_conflict'}]});
  // 价格必须已知（问清才扣库存 + 记成本）
  if (item.price_fen == null && payload.priceFen == null) {
    throw new AppError('NEEDS_INPUT', '该物资价格未知，请先告知价格', { details: [{ field: 'price', reason: 'price_unknown' }] });
  }
  // 负库存阻止：校验先于扣减
  if (Number(item.quantity) < quantity) {
    throw new AppError('SCHEMA_INVALID', `库存不足：现有 ${item.quantity}${item.unit ?? ''}，需 ${quantity}${unit ?? ''}`);
  }

  const unitPriceFen = Number(item.price_fen ?? payload.priceFen);
  if(!Number.isSafeInteger(unitPriceFen)||unitPriceFen<=0)throw new AppError('SCHEMA_INVALID','单价必须为正整数分');
  if(item.price_fen==null)repo.updateItemPrice(itemId,unitPriceFen);
  const amountFen = Math.round(quantity * unitPriceFen);
  repo.updateItemQuantity(itemId, Number(item.quantity) - quantity);
  repo.insertRecord({ id: uuid(), type: 'use_item', catId, itemId, businessDate: today(), amountFen, quantity, unitPriceFen, sourceInputId });
}

// 更正记录：记录修改 + 库存/成本重算，同一事务；旧版本不能覆盖新结果
interface CorrectPatch { quantity?: number; amountFen?: number; weightGram?: number; text?: string; reason?: string }
function validatePatch(patch: CorrectPatch): void {
  if (patch.quantity !== undefined && (typeof patch.quantity !== 'number' || !Number.isFinite(patch.quantity) || patch.quantity <= 0)) {
    throw new AppError('SCHEMA_INVALID', 'quantity 必须为正数', { httpStatus: 400 });
  }
  if (patch.amountFen !== undefined && (typeof patch.amountFen !== 'number' || !Number.isSafeInteger(patch.amountFen) || patch.amountFen <= 0)) {
    throw new AppError('SCHEMA_INVALID', 'amountFen 必须为正整数（分）', { httpStatus: 400 });
  }
  if (patch.weightGram !== undefined && (typeof patch.weightGram !== 'number' || !Number.isSafeInteger(patch.weightGram) || patch.weightGram <= 0)) {
    throw new AppError('SCHEMA_INVALID', 'weightGram 必须为正整数（克）', { httpStatus: 400 });
  }
  if (patch.text !== undefined && typeof patch.text !== 'string') throw new AppError('SCHEMA_INVALID', 'text 必须为字符串', { httpStatus: 400 });
  if (patch.reason !== undefined && typeof patch.reason !== 'string') throw new AppError('SCHEMA_INVALID', 'reason 必须为字符串', { httpStatus: 400 });
}
export function correctRecord(repo: Repo, recordId: string, patch: CorrectPatch, version: number): void {
  validatePatch(patch); // 入口字段合法性校验：负数/错误类型/非法值直接拒绝
  repo.transaction(() => {
    const cur = repo.getRecord(recordId);
    if (!cur) throw new AppError('NOT_FOUND', '记录不存在');

    if (cur.type === 'use_item') {
      const item = repo.getItem(cur.item_id);
      if (!item) throw new AppError('NOT_FOUND', '物资不存在');
      const newQty = patch.quantity ?? Number(cur.quantity);
      const restored = Number(item.quantity) + Number(cur.quantity); // 回到扣减前
      if (restored - newQty < 0) throw new AppError('SCHEMA_INVALID', '更正后库存为负，已阻止');
      const newAmountFen = Math.round(newQty * Number(cur.unit_price_fen)); // 按原单价快照重算
      repo.updateItemQuantity(cur.item_id, restored - newQty);
      guardVersion(repo.updateRecordFields(recordId, version, { quantity: newQty, amountFen: newAmountFen }));
      return;
    }
    if (cur.type === 'item_stock') {
      const item = repo.getItem(cur.item_id);
      if (!item) throw new AppError('NOT_FOUND', '物资不存在');
      const newQty = patch.quantity ?? Number(cur.quantity);
      const before = Number(item.quantity) - Number(cur.quantity); // 入库前
      if (before + newQty < 0) throw new AppError('SCHEMA_INVALID', '更正后库存为负，已阻止');
      repo.updateItemQuantity(cur.item_id, before + newQty);
      guardVersion(repo.updateRecordFields(recordId, version, { quantity: newQty }));
      return;
    }
    if (cur.type === 'expense') {
      guardVersion(repo.updateRecordFields(recordId, version, { amountFen: patch.amountFen ?? Number(cur.amount_fen), reason: patch.reason }));
      return;
    }
    if (cur.type === 'weight') {
      guardVersion(repo.updateRecordFields(recordId, version, { weightGram: patch.weightGram ?? Number(cur.weight_gram) }));
      return;
    }
    if (cur.type === 'observation') {
      guardVersion(repo.updateRecordFields(recordId, version, { text: patch.text ?? cur.text }));
      return;
    }
  });
}

// 删除记录：恢复库存/撤销成本，同一事务；重复删除不重复调整
function guardVersion(r: { changes: number | bigint }): void {
  if (Number(r.changes) === 0) throw new AppError('VERSION_CONFLICT', '记录已被修改，请刷新后重试', { retryable: false });
}

export function deleteRecord(repo: Repo, recordId: string, version: number): void {
  repo.transaction(() => {
    const cur = repo.getRecord(recordId);
    if (!cur) throw new AppError('NOT_FOUND', '记录不存在');
    if (cur.type === 'use_item') {
      const item = repo.getItem(cur.item_id);
      if (!item) throw new AppError('NOT_FOUND', '物资不存在');
      repo.updateItemQuantity(cur.item_id, Number(item.quantity) + Number(cur.quantity));
    } else if (cur.type === 'item_stock') {
      const item = repo.getItem(cur.item_id);
      if (!item) throw new AppError('NOT_FOUND', '物资不存在');
      const newQty = Number(item.quantity) - Number(cur.quantity);
      if (newQty < 0) throw new AppError('SCHEMA_INVALID', '删除后库存为负，已阻止');
      repo.updateItemQuantity(cur.item_id, newQty);
    }
    guardVersion(repo.deleteRecordWithVersion(recordId, version));
  });
}
