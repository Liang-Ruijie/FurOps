// 8 命令结构校验（服务端二次校验第一层：结构/类型/范围，不查库；存在性校验在 records.ts 执行时做）
import { todayShanghai } from './time.ts';
export type CommandType =
  | 'weight' | 'observation' | 'expense' | 'use_item'
  | 'item_stock' | 'create_cat' | 'create_litter' | 'clarify';

export const COMMAND_TYPES: CommandType[] = [
  'weight', 'observation', 'expense', 'use_item', 'item_stock', 'create_cat', 'create_litter', 'clarify',
];

// 金额：AI 只提取"原金额 + 单位"，程序换算成分；AI 不得自行换算
export const AMOUNT_UNITS: Record<string, number> = { '元': 100, '角': 10, '分': 1 };

export interface Command {
  type: CommandType;
  payload: Record<string, unknown>;
}

export interface ParseOk { ok: true; items: Array<Record<string, unknown>> }
export interface ParseFail { ok: false; error: string }
export function parsePlan(raw: unknown): ParseOk | ParseFail {
  const obj = (Array.isArray(raw) ? { items: raw } : raw) as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj !== 'object') return { ok: false, error: '模型输出不是对象' };
  const items = obj['items'];
  if (!Array.isArray(items)) return { ok: false, error: '模型输出缺少 items 数组' };
  return { ok: true, items: items as Array<Record<string, unknown>> };
}

// 只由程序换算一次；允许元/角的小数，但必须精确到整数分，不静默四舍五入。
export function convertAmountFen(amount: unknown, unit: unknown): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new Error('金额必须为正整数分或能精确换算成分的正数');
  if (typeof unit !== 'string' || !Object.hasOwn(AMOUNT_UNITS,unit)) throw new Error('金额单位必须是 元/角/分');
  const parts=String(amount).split('.');
  if(!/^\d+$/.test(parts[0])||(parts[1]&&!/^\d+$/.test(parts[1])))throw new Error('金额换算后超出范围或不足一分');
  const fraction=parts[1]||'';
  const numerator=BigInt(parts[0]+fraction)*BigInt(AMOUNT_UNITS[unit]);
  const denominator=10n**BigInt(fraction.length);
  if(numerator%denominator!==0n)throw new Error('金额必须精确到正整数分，不自动舍入');
  const fen=numerator/denominator;
  if(fen<=0n||fen>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('金额换算后超出范围');
  return Number(fen);
}

function str(raw: Record<string, unknown>, k: string): string | undefined {
  const v = raw[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(raw: Record<string, unknown>, k: string): number | undefined {
  const v = raw[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export interface ValidateOk { ok: true; command: Command }
export interface ValidateFail { ok: false; errors: string[] }
export function validateItem(raw: Record<string, unknown>): ValidateOk | ValidateFail {
  const errors: string[] = [];
  const t = raw['commandType'];
  if (typeof t !== 'string' || !(COMMAND_TYPES as string[]).includes(t)) {
    return { ok: false, errors: ['commandType 缺失或不在白名单'] };
  }
  const type = t as CommandType;
  const needStr = (k: string) => { const v = str(raw, k); if (v == null) errors.push(`${type} 缺字段 ${k}`); return v; };

  if (type === 'weight') {
    const catId = needStr('catId');
    const date = needStr('date');
    const g = num(raw, 'weightGram');
    if (g == null || !Number.isSafeInteger(g) || g <= 0) errors.push('weight 的 weightGram 必须为正整数克');
    if (!errors.length) return { ok: true, command: { type, payload: { catId, date, weightGram: g } } };
  } else if (type === 'observation') {
    const text = needStr('text');
    const date = str(raw, 'date');
    const catId = str(raw, 'catId') ?? null;
    if (!errors.length) return { ok: true, command: { type, payload: { catId, date: date ?? todayShanghai(), text } } };
  } else if (type === 'expense') {
    const catId = needStr('catId');
    const amount = num(raw, 'amount');
    const unit = str(raw, 'amountUnit');
    const reason = str(raw, 'reason') ?? '';
    if (amount == null) errors.push('expense 缺字段 amount');
    else { try { convertAmountFen(amount, unit); } catch (e) { errors.push((e as Error).message); } }
    if (!errors.length) return { ok: true, command: { type, payload: { catId, amountFen: convertAmountFen(amount, unit), reason } } };
  } else if (type === 'use_item') {
    const itemId = needStr('itemId');
    const catId = needStr('catId');
    const q = num(raw, 'quantity');
    const unit = str(raw, 'unit') ?? null;
    if (q == null || q <= 0) errors.push('use_item 的 quantity 必须为正数');
    let priceFen: number | null = null;
    if(raw.price!=null){try{const p=raw.price as Record<string,unknown>;priceFen=convertAmountFen(p.amount,p.amountUnit);}catch(e){errors.push('price：'+(e as Error).message);}}
    if (!errors.length) return { ok: true, command: { type, payload: { itemId, catId, quantity: q, unit, ...(priceFen==null?{}:{priceFen}) } } };
  } else if (type === 'item_stock') {
    const itemId = str(raw, 'itemId') ?? null;
    const name = str(raw, 'name') ?? null;
    const unit=str(raw,'unit')??null;
    const q = num(raw, 'quantity');
    const expiryDate = str(raw, 'expiryDate') ?? null;
    if (!itemId && !name) errors.push('item_stock 至少需要 itemId 或 name');
    if (q == null || q <= 0) errors.push('item_stock 的 quantity 必须为正数');
    let priceFen: number | null = null;
    const price = raw['price'];
    if (price != null) {
      const p = price as Record<string, unknown>;
      try { priceFen = convertAmountFen(p['amount'], p['amountUnit']); } catch (e) { errors.push('price：' + (e as Error).message); }
    }
    if (!errors.length) return { ok: true, command: { type, payload: { itemId, name, quantity: q, priceFen, expiryDate,unit } } };
  } else if (type === 'create_cat') {
    const name = needStr('name');
    const role = needStr('role');
    const sex = str(raw, 'sex') ?? null;
    const birth = str(raw, 'birth') ?? null;
    const motherId = str(raw, 'motherId') ?? null;
    const litterId = str(raw, 'litterId') ?? null;
    if (role && !['male', 'mother', 'kitten'].includes(role)) errors.push('create_cat 的 role 必须是 male/mother/kitten');
    if (role === 'kitten' && (!motherId || !litterId)) errors.push('小猫必须带 motherId 和 litterId');
    if (!errors.length) return { ok: true, command: { type, payload: { name, sex, birth, role, motherId, litterId } } };
  } else if (type === 'create_litter') {
    const motherId = needStr('motherId');
    const birthDate = str(raw, 'birthDate') ?? null;
    const name = str(raw, 'name') ?? null;
    if (!errors.length) return { ok: true, command: { type, payload: { motherId, birthDate, name } } };
  } else if (type === 'clarify') {
    const missingFields = raw['missingFields'];
    const question = needStr('question');
    if (!Array.isArray(missingFields) || missingFields.length === 0 || !missingFields.every(f => typeof f === 'string')) {
      errors.push('clarify 的 missingFields 必须为非空字符串数组');
    }
    const pp = raw['partialPayload'];
    const partialPayload = (pp && typeof pp === 'object' && !Array.isArray(pp)) ? pp as Record<string, unknown> : null;
    if (!errors.length) return { ok: true, command: { type, payload: { missingFields, question, partialPayload } } };
  }

  return { ok: false, errors };
}
