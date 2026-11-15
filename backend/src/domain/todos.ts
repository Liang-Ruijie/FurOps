import type { DatabaseSync } from 'node:sqlite';
import { todayShanghai } from './time.ts';

export interface Todo {
  type: 'weight_drop' | 'low_stock' | 'expiring' | 'health_due' | 'needs_input';
  priority: number;
  label: string;
  detail: string;
  catId?: string | null;
  itemId?: string | null;
  targetItemId?: string | null;
}

export interface WeightStatus {
  status: '下降' | '回升' | '恢复' | '无数据';
  latest?: number;
  previous?: number;
  baseline?: number;
}

// 体重按实际测量顺序比较（传入按 business_date/created_at 升序的记录）
export function weightStatus(weights: Array<{ weightGram: number }>): WeightStatus {
  if (weights.length < 2) return { status: '无数据' };
  const latest = weights[weights.length - 1].weightGram;
  const previous = weights[weights.length - 2].weightGram;
  if (latest < previous) return { status: '下降', latest, previous };
  // 回升/持平：找最近一次下降前的基线，判断是否仍低于基线
  for (let i = weights.length - 1; i >= 1; i--) {
    if (weights[i].weightGram < weights[i - 1].weightGram) {
      const baseline = weights[i - 1].weightGram;
      if (latest < baseline) return { status: '回升', latest, previous, baseline };
      return { status: '恢复', latest, previous };
    }
  }
  return { status: '恢复', latest, previous };
}

function addDays(yyyymmdd: string, days: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function computeTodos(db: DatabaseSync): Todo[] {
  const todos: Todo[] = [];
  const today = todayShanghai();
  const cats = db.prepare('SELECT id, name FROM cat ORDER BY created_at').all() as Array<{ id: string; name: string }>;

  // 🔴 1 体重下降
  for (const cat of cats) {
    const weights = db.prepare("SELECT weight_gram AS weightGram FROM record WHERE cat_id=? AND type='weight' ORDER BY business_date, created_at").all(cat.id) as Array<{ weightGram: number }>;
    const st = weightStatus(weights);
    if (st.status === '下降') {
      todos.push({ type: 'weight_drop', priority: 1, label: `复称 · ${cat.name}`, detail: `最新 ${st.latest}g < 上次 ${st.previous}g`, catId: cat.id });
    }
  }

  // 🟠 2 物资不足（消耗品）
  const lowItems = db.prepare("SELECT id, name, quantity, unit, low_stock_threshold FROM item WHERE category IN ('food','litter')").all() as Array<any>;
  for (const it of lowItems) {
    if (it.low_stock_threshold != null && Number(it.quantity) <= Number(it.low_stock_threshold)) {
      todos.push({ type: 'low_stock', priority: 2, label: `${it.name} · 快没货`, detail: `剩 ${it.quantity}${it.unit ?? ''}，阈值 ${it.low_stock_threshold}`, itemId: it.id });
    }
  }

  // 🟠 3 药品快过期（数量 > 0 才提醒）
  const cfg = db.prepare('SELECT reminder_advance_days FROM app_config LIMIT 1').get() as any;
  const advance = Number(cfg?.reminder_advance_days ?? 30);
  const expiring = db.prepare("SELECT id, name, quantity, unit, expiry_date FROM item WHERE category='medicine' AND quantity > 0 AND expiry_date IS NOT NULL").all() as Array<any>;
  for (const it of expiring) {
    if (it.expiry_date <= addDays(today, advance)) {
      todos.push({ type: 'expiring', priority: 3, label: `${it.name} · 快过期`, detail: `${it.expiry_date} 到期`, itemId: it.id });
    }
  }

  // 🟡 4 驱虫/疫苗到期（分别读各自最新记录，登记一种不清除另一种提醒）
  for (const cat of cats) {
    for (const [type, label] of [['vaccine', '疫苗'], ['deworm', '驱虫']] as const) {
      const rec = db.prepare('SELECT next_due_date FROM health_record WHERE cat_id=? AND type=? ORDER BY date DESC, created_at DESC LIMIT 1').get(cat.id, type) as any;
      if (rec && rec.next_due_date && rec.next_due_date <= today) {
        todos.push({ type: 'health_due', priority: 4, label: `${cat.name} · ${label}该做了`, detail: `${rec.next_due_date} 到期`, catId: cat.id });
      }
    }
  }

  // 🟡 5 待补充（存表）
  const pending = db.prepare("SELECT id, missing_fields,proposed_payload FROM intent_item WHERE state='needs_input' ORDER BY created_at").all() as Array<any>;
  for (const p of pending) {
    let fields = '请补充这条记录的信息';
    try {
      const names:Record<string,string>={catId:'猫咪',itemId:'物资',weightGram:'体重',quantity:'数量',price:'单价',priceFen:'单价',unit:'计量单位',date:'日期',motherId:'所属母猫',litterId:'所属窝次'};
      const payload=JSON.parse(p.proposed_payload||'{}');
      const missing=JSON.parse(p.missing_fields) as string[];
      fields=typeof payload.question==='string'?payload.question:'请补充或核对'+missing.map(f=>names[f]||'相关信息').join('、');
    } catch { /* 保持可读提示，不显示内部字段名 */ }
    todos.push({ type: 'needs_input', priority: 5, label: '待补充', detail: fields, targetItemId: p.id });
  }

  todos.sort((a, b) => a.priority - b.priority);
  return todos;
}
