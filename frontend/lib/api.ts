// 集中式 API 层 + 类型（前端只通过这里调后端，不在组件散落 fetch）

export interface Todo {
  type: 'weight_drop' | 'low_stock' | 'expiring' | 'health_due' | 'needs_input';
  priority: number;
  label: string;
  detail: string;
  catId?: string | null;
  itemId?: string | null;
  targetItemId?: string | null;
}

export interface InputState {
  id: string;
  state: string;
  textBody?: string;
  capturedAt?: string;
}

// 后端状态 → 前端展示文案
export function stateLabel(state: string | undefined): string {
  switch (state) {
    case 'received': return '已收到';
    case 'processing': return '整理中';
    case 'completed': return '已入档';
    case 'no_changes': return '原文已保存，尚未生成业务记录';
    case 'needs_input': return '待补充';
    case 'pending': return '待执行'; // 用药等后台"待执行"，非"部分成功"
    case 'partial': return '部分已入档，其余未完成';
    case 'failed': return '整理失败';
    default: return '发送中';
  }
}

async function j<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(body?.error?.code ?? 'ERROR', body?.error?.message ?? '请求失败', r.status);
  return body as T;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// 普通本机请求超时后保留表单；发送结果不明仍使用原标识自动核实。
async function request(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
 try{return await fetch(input,{...init,signal:controller.signal});}
 catch{throw new ApiError(controller.signal.aborted?'TIMEOUT':'NETWORK',controller.signal.aborted?'等待电脑响应超时，内容已保留，请稍后重试':'暂时连接不上电脑，请检查连接后重试',0);}
 finally{clearTimeout(timer);}
}

export const api = {
  async todos(): Promise<Todo[]> {
    const r = await request('/api/v1/todos', { cache: 'no-store' });
    return (await j<{ todos: Todo[] }>(r)).todos;
  },
  async submit(payload: { text: string; idempotencyKey: string; boundCatId?: string | null; targetItemId?: string | null; mediaIds?: string[] }): Promise<InputState> {
    const r = await request('/api/v1/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await j<{ input: InputState }>(r)).input;
  },
  async getInput(id: string): Promise<InputState> {
    const r = await request(`/api/v1/input/${id}`, { cache: 'no-store' });
    const result=await j<{input:InputState;intentItems:Array<{state:string}>}>(r);
    if(result.input.state==='failed'&&result.intentItems.some(it=>it.state==='completed'))result.input.state='partial';
    if(result.input.state==='completed'&&result.intentItems.length===0)result.input.state='no_changes';
    return result.input;
  },
  async retry(id: string): Promise<InputState> {
    const r = await request(`/api/v1/input/${id}/retry`, { method: 'POST' });
    return (await j<{ input: InputState }>(r)).input;
  },
  // 猫咪 / 窝次 / 物资
  async cats(): Promise<Cat[]> { const r = await request('/api/v1/cats', { cache: 'no-store' }); return (await j<{ cats: Cat[] }>(r)).cats; },
  async catDetail(id: string): Promise<CatDetail> { const r = await request(`/api/v1/cats/${id}`, { cache: 'no-store' }); return j<CatDetail>(r); },
  async createCat(p: { name: string; role: string; sex: string | null; birthDate: string | null; motherId: string | null; litterId: string | null }): Promise<void> { await j(await request('/api/v1/cats', { method: 'POST', headers: H, body: JSON.stringify(p) })); },
  async editCat(id: string, patch: Record<string, unknown>, version: number): Promise<void> { await j(await request(`/api/v1/cats/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ...patch, version }) })); },
  async litters(): Promise<Litter[]> { const r = await request('/api/v1/litters', { cache: 'no-store' }); return (await j<{ litters: Litter[] }>(r)).litters; },
  async createLitter(p: { motherId: string; name: string | null; birthDate: string | null }): Promise<void> { await j(await request('/api/v1/litters', { method: 'POST', headers: H, body: JSON.stringify(p) })); },
  async items(): Promise<Item[]> { const r = await request('/api/v1/items', { cache: 'no-store' }); return (await j<{ items: Item[] }>(r)).items; },
  async createItem(p: Record<string, unknown>): Promise<void> { await j(await request('/api/v1/items', { method: 'POST', headers: H, body: JSON.stringify(p) })); },
  async editItem(id: string, patch: Record<string, unknown>, version: number): Promise<void> { await j(await request(`/api/v1/items/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ...patch, version }) })); },
  async registerHealth(p:{catId:string;type:string;date:string;nextDueDate:string|null;note:string|null}):Promise<void>{await j(await request('/api/v1/health-records',{method:'POST',headers:H,body:JSON.stringify(p)}));},
  // 事件记录 / 照片
  async records(filter: { type?: string; catId?: string; dateFrom?: string; dateTo?: string } = {}): Promise<RecordRow[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) q.set(k, v);
    const r = await request('/api/v1/records' + (q.toString() ? '?' + q.toString() : ''), { cache: 'no-store' });
    return (await j<{ records: RecordRow[] }>(r)).records;
  },
  async uploadMedia(mime: string, base64: string): Promise<{ id: string; relativePath: string }> {
    const r = await request('/api/v1/media', { method: 'POST', headers: H, body: JSON.stringify({ mime, data: base64 }) });
    return j<{ id: string; relativePath: string }>(r);
  },
  async correctRecord(id: string, patch: Record<string, unknown>, version: number): Promise<void> { await j(await request(`/api/v1/records/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ...patch, version }) })); },
  async deleteRecord(id: string, version: number): Promise<void> { await j(await request(`/api/v1/records/${id}?version=${version}`, { method: 'DELETE' })); },
};

const H = { 'Content-Type': 'application/json' };

export interface Cat { id: string; role: 'male' | 'mother' | 'kitten'; name: string; sex: string | null; birthDate: string | null; motherId: string | null; litterId: string | null; version: number; latestWeight: number | null; costFen: number; costRecordCount:number; }
export interface Litter { id: string; mother_id: string; name: string | null; birth_date: string | null; }
export interface Item { id: string; name: string; category: string; quantity: number; unit: string | null; price_fen: number | null; expiry_date: string | null; low_stock_threshold: number | null; version: number; }
export interface CatDetail { cat: Record<string, unknown>; weights: Array<{ id: string; businessDate: string; weightGram: number }>; health: Array<{ id: string; type: string; date: string; nextDueDate: string | null; note: string | null }>; }
export interface RecordRow { mediaIds:string[]; id: string; type: string; catId: string | null; itemId: string | null; businessDate: string; weightGram: number | null; text: string | null; amountFen: number | null; quantity: number | null; unitPriceFen: number | null; reason: string | null; version: number; catName: string | null; itemName: string | null; itemUnit: string | null; }
