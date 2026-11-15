import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.ts';
import { uuid } from './auth.ts';
import {validDate,todayShanghai} from './time.ts';
import type { Repo } from './repo.ts';

function guard(r: { changes: number | bigint }): void {
  if (Number(r.changes) === 0) throw new AppError('VERSION_CONFLICT', '记录已被修改，请刷新后重试', { retryable: false });
}

function birthCheck(value:string|null|undefined):void{if(value&&(!validDate(value)||value>todayShanghai()))throw new AppError('SCHEMA_INVALID','出生日期必须是今天或过去的有效日期');}
const CATEGORIES = ['food', 'litter', 'medicine', 'toy', 'other'];

// 建档（表单）：母猫/公猫/小猫；小猫的窝次必须属于所选母猫（避免关系错配）
export function createCat(repo: Repo, p: { name: string; role: string; sex: string | null; birthDate: string | null; motherId: string | null; litterId: string | null }): { id: string } {
  const name = (p.name ?? '').trim();
  if ('birthDate' in p)birthCheck(p.birthDate);
  if (!name) throw new AppError('SCHEMA_INVALID', '名字不能为空');
  if (!['male', 'mother', 'kitten'].includes(p.role)) throw new AppError('SCHEMA_INVALID', 'role 必须是 male/mother/kitten');
  if (p.role === 'kitten') {
    if (!p.motherId || !p.litterId) throw new AppError('SCHEMA_INVALID', '小猫必须选择母猫和窝次');
    if (repo.getCat(p.motherId)?.role!=='mother')throw new AppError('SCHEMA_INVALID','所属档案必须是母猫');
    const litter = repo.getLitter(p.litterId);
    if (!litter) throw new AppError('NOT_FOUND', '窝次不存在');
    if (litter.mother_id !== p.motherId) throw new AppError('SCHEMA_INVALID', '窝次不属于所选母猫');
  } else {
    const dup = repo.listCatsByName(name).filter(c => c.role === 'male' || c.role === 'mother');
    if (dup.length > 0) throw new AppError('SCHEMA_INVALID', `已存在同名公/母猫「${name}」，不重复建档`);
  }
  const id = uuid();
  repo.insertCat({ id, role: p.role, name, sex: p.sex, birthDate: p.birthDate, motherId: p.motherId, litterId: p.litterId });
  return { id };
}

export function editCat(repo: Repo, id: string, patch: { name?: string; sex?: string | null; birthDate?: string | null }, version: number): void {
  if (!repo.getCat(id)) throw new AppError('NOT_FOUND', '猫咪不存在');
  if ('birthDate' in patch)birthCheck(patch.birthDate);
  if (patch.name !== undefined && !patch.name.trim()) throw new AppError('SCHEMA_INVALID', '名字不能为空');
  guard(repo.updateCatFields(id, version, patch));
}

export function createLitter(repo: Repo, p: { motherId: string; name: string | null; birthDate: string | null }): { id: string } {
  birthCheck(p.birthDate);
  if (repo.getCat(p.motherId)?.role!=='mother')throw new AppError('SCHEMA_INVALID','所属档案必须是母猫');
  const id = uuid();
  repo.insertLitter({ id, motherId: p.motherId, name: p.name, birthDate: p.birthDate });
  return { id };
}

export function createItem(repo: Repo, p: { name: string; category: string; quantity: number; unit: string | null; priceFen: number | null; expiryDate: string | null; lowStockThreshold: number | null }): { id: string } {
  const name = (p.name ?? '').trim();
  if (!name) throw new AppError('SCHEMA_INVALID', '名称不能为空');
  if (!CATEGORIES.includes(p.category)) throw new AppError('SCHEMA_INVALID', '分类非法');
  if (typeof p.quantity !== 'number' || !Number.isFinite(p.quantity) || p.quantity < 0) throw new AppError('SCHEMA_INVALID', '数量不能为负');
  if (p.priceFen != null && (typeof p.priceFen !== 'number' || !Number.isSafeInteger(p.priceFen) || p.priceFen <= 0)) throw new AppError('SCHEMA_INVALID', '价格必须为正整数（分）或留空');
  const id = uuid();
  repo.insertItem({ id, name, category: p.category, quantity: p.quantity, unit: p.unit, priceFen: p.priceFen, expiryDate: p.expiryDate });
  if (p.lowStockThreshold != null) repo.updateItemFields(id, 1, { lowStockThreshold: p.lowStockThreshold });
  return { id };
}

// 编辑物资：校验当前版本（防止旧表单覆盖期间的用药扣减/入库）；数量非负；改价不改历史费用（只改 item.price_fen，历史 record.unit_price_fen 不变）
export function editItem(repo: Repo, id: string, patch: { name?: string; category?: string; quantity?: number; unit?: string | null; priceFen?: number | null; expiryDate?: string | null; lowStockThreshold?: number | null }, version: number): void {
  const item = repo.getItem(id);
  if (!item) throw new AppError('NOT_FOUND', '物资不存在');
  if (patch.name !== undefined && !patch.name.trim()) throw new AppError('SCHEMA_INVALID', '名称不能为空');
  if (patch.category !== undefined && !CATEGORIES.includes(patch.category)) throw new AppError('SCHEMA_INVALID', '分类非法');
  if (patch.quantity !== undefined && (typeof patch.quantity !== 'number' || !Number.isFinite(patch.quantity) || patch.quantity < 0)) throw new AppError('SCHEMA_INVALID', '数量不能为负');
  if (patch.priceFen !== undefined && patch.priceFen != null && (typeof patch.priceFen !== 'number' || !Number.isSafeInteger(patch.priceFen) || patch.priceFen <= 0)) throw new AppError('SCHEMA_INVALID', '价格必须为正整数（分）或留空');
  guard(repo.updateItemFields(id, version, patch));
}

// 猫咪列表摘要（最新体重 + 当前成本）
export function listCatsSummary(db: DatabaseSync): Array<Record<string, unknown>> {
  const cats = db.prepare('SELECT id, role, name, sex, birth_date AS birthDate, mother_id AS motherId, litter_id AS litterId, version FROM cat ORDER BY created_at').all() as Array<any>;
  return cats.map(c => {
    const lw = db.prepare("SELECT weight_gram AS g FROM record WHERE cat_id=? AND type='weight' ORDER BY business_date DESC, created_at DESC LIMIT 1").get(c.id) as any;
    const cost = db.prepare("SELECT COALESCE(SUM(amount_fen),0) n, COUNT(*) count FROM record WHERE cat_id=? AND type IN ('expense','use_item')").get(c.id) as any;
    return { id: c.id, role: c.role, name: c.name, sex: c.sex, birthDate: c.birthDate, motherId: c.motherId, litterId: c.litterId, version: Number(c.version), latestWeight: lw?.g != null ? Number(lw.g) : null, costFen: Number(cost.n), costRecordCount:Number(cost.count) };
  });
}

// 物资列表（BigInt 字段转 Number）
export function listItemsSummary(db: DatabaseSync): Array<Record<string, unknown>> {
  const items = db.prepare('SELECT id, name, category, quantity, unit, price_fen, expiry_date, low_stock_threshold, version FROM item ORDER BY created_at').all() as Array<any>;
  return items.map(i => ({
    id: i.id, name: i.name, category: i.category, quantity: Number(i.quantity), unit: i.unit,
    price_fen: i.price_fen != null ? Number(i.price_fen) : null, expiry_date: i.expiry_date,
    low_stock_threshold: i.low_stock_threshold != null ? Number(i.low_stock_threshold) : null, version: Number(i.version),
  }));
}

export function getCatDetail(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const cat = db.prepare('SELECT * FROM cat WHERE id=?').get(id) as any;
  if (!cat) return null;
  const weights = db.prepare("SELECT id, business_date AS businessDate, weight_gram AS weightGram FROM record WHERE cat_id=? AND type='weight' ORDER BY business_date, created_at").all(id) as Array<any>;
  const health = db.prepare('SELECT id, type, date, next_due_date AS nextDueDate, note FROM health_record WHERE cat_id=? ORDER BY date DESC').all(id) as Array<any>;
  return {
    cat: { id: cat.id, role: cat.role, name: cat.name, sex: cat.sex, birth_date: cat.birth_date, mother_id: cat.mother_id, litter_id: cat.litter_id, version: Number(cat.version) },
    weights: weights.map(w => ({ id: w.id, businessDate: w.businessDate, weightGram: Number(w.weightGram) })),
    health,
  };
}
