import type { DatabaseSync } from 'node:sqlite';

// 记忆取回：为规划器注入候选猫/物资/近期记录/待补事项/接续目标/绑定猫（各设上限，超出截断）
export interface PlannerContext {
  cats: Array<{ id: string; name: string; role: string; birthDate?:string|null }>;
  items: Array<{ id: string; name: string; unit: string | null; priceFen: number | null }>;
  litters: Array<Record<string,unknown>>;
  truncated: {cats:boolean;items:boolean;pending:boolean};
  ambiguousCatNames:string[];
  ambiguousItemNames:string[];
  recentRecords: Array<Record<string, unknown>>;
  pendingItems: Array<{ id: string; commandType: string | null; missingFields: string }>;
  targetItem: {
    id: string;
    commandType: string | null;
    missingFields: string;
    partialPayload: Record<string, unknown> | null;
    originalInput: string | null;
  } | null;
  boundCat: { id: string; name: string; role: string } | null;
}

export function buildContext(db: DatabaseSync, _text: string, targetItemId: string | null, boundCatId: string | null = null): PlannerContext {
  let cats = db.prepare('SELECT id, name, role, birth_date AS birthDate, mother_id AS motherId,litter_id AS litterId FROM cat ORDER BY created_at').all() as Array<{ id: string; name: string; role: string }>;
  let items = db.prepare('SELECT id, name, unit, price_fen AS priceFen FROM item ORDER BY created_at').all() as Array<{ id: string; name: string; unit: string | null; priceFen: number | null }>;
  let recentRecords = db.prepare('SELECT type, cat_id AS catId, business_date AS businessDate, weight_gram AS weightGram, text, amount_fen AS amountFen, quantity FROM record ORDER BY created_at DESC LIMIT 12').all() as Array<Record<string, unknown>>;
  const pendingItems = db.prepare("SELECT id, command_type AS commandType, missing_fields AS missingFields FROM intent_item WHERE state='needs_input' ORDER BY created_at LIMIT 5").all() as Array<{ id: string; commandType: string | null; missingFields: string }>;

  let targetItem: PlannerContext['targetItem'] = null;
  if (targetItemId) {
    const row = db.prepare("SELECT ii.id, ii.command_type AS commandType, ii.missing_fields AS missingFields, ii.proposed_payload AS proposedPayload, ir.text_body AS originalInput FROM intent_item ii LEFT JOIN input_record ir ON ir.id = ii.input_id WHERE ii.id=?").get(targetItemId) as any;
    if (row) {
      let partialPayload: Record<string, unknown> | null = null;
      try {
        const p = JSON.parse(row.proposedPayload ?? '{}');
        if (p && typeof p === 'object') {if(p.partialPayload&&typeof p.partialPayload==='object')partialPayload=p.partialPayload;else if(row.commandType&&row.commandType!=='clarify')partialPayload={commandType:row.commandType,...p};}
      } catch { /* 解析失败按无 partialPayload 处理 */ }
      targetItem = {
        id: row.id,
        commandType: row.commandType,
        missingFields: row.missingFields,
        partialPayload,
        originalInput: row.originalInput ?? null,
      };
    }
  }

  const allCats=cats,allItems=items;
  const mentionedCats=cats.filter(c=>_text.includes(c.name));
  const mentionedItems=items.filter(i=>_text.includes(i.name));
  const preferredCat=targetItem?.partialPayload?.catId??boundCatId;
  const preferredItem=targetItem?.partialPayload?.itemId;
  const prioritize=<T extends {id:string}>(rows:T[],mentions:T[],preferred:unknown,limit:number):T[]=>{
    const first=[...mentions,...rows.filter(r=>r.id===preferred)];
    return [...first,...rows.filter(r=>!first.some(f=>f.id===r.id))].filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i).slice(0,limit);
  };
  cats=prioritize(cats,mentionedCats,preferredCat,20);
  items=prioritize(items,mentionedItems,preferredItem,50);
  const factCats=mentionedCats.length?mentionedCats.map(c=>c.id):preferredCat?[String(preferredCat)]:[];
  if(factCats.length){recentRecords=db.prepare(`SELECT type,cat_id AS catId,business_date AS businessDate,weight_gram AS weightGram,text,amount_fen AS amountFen,quantity FROM record WHERE cat_id IN (${factCats.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT 12`).all(...factCats) as Array<Record<string,unknown>>;}
  const mothers=cats.filter(c=>c.role==='mother').map(c=>c.id);
  const litters=mothers.length?db.prepare(`SELECT id,mother_id AS motherId,name,birth_date AS birthDate FROM litter WHERE mother_id IN (${mothers.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT 20`).all(...mothers) as Array<Record<string,unknown>>:[];
  const duplicates=(rows:Array<{name:string}>)=>[...new Set(rows.filter((r,i)=>rows.some((other,j)=>j!==i&&other.name===r.name)).map(r=>r.name))];
  const ambiguousCatNames=duplicates(allCats),ambiguousItemNames=duplicates(allItems);
  const truncated={cats:allCats.length>20,items:allItems.length>50,pending:Number((db.prepare("SELECT COUNT(*) n FROM intent_item WHERE state='needs_input'").get() as any).n)>5};
  const boundCat = boundCatId ? (db.prepare('SELECT id, name, role FROM cat WHERE id=?').get(boundCatId) as { id: string; name: string; role: string } | undefined) || null : null;

  return { cats, items, litters, truncated, ambiguousCatNames, ambiguousItemNames, recentRecords, pendingItems, targetItem, boundCat };
}
