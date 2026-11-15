import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { AppError } from '../domain/errors.ts';
import { correctRecord, deleteRecord, registerHealthRecord } from '../domain/records.ts';
import { computeTodos } from '../domain/todos.ts';
import { createCat, editCat, createLitter, createItem, editItem, listCatsSummary, getCatDetail, listItemsSummary } from '../domain/catalog.ts';
import { listRecords } from '../domain/records.ts';
import { saveMedia } from '../domain/media.ts';
import { transcribeWav } from '../domain/asr.ts';

const app = createApp();

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (Buffer.byteLength(s) > maxBytes) { reject(new AppError('FILE_LIMIT', '请求体过大')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new AppError('SCHEMA_INVALID', 'JSON 解析失败', { httpStatus: 400 })); } });
    req.on('error', reject);
  });
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > maxBytes) { reject(new AppError('FILE_LIMIT', '请求体过大')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toErrorBody(e: unknown): { status: number; body: unknown } {
  if (e instanceof AppError) return { status: e.httpStatus, body: e.toBody() };
  return { status: 500, body: { error: { code: 'INTERNAL', message: (e as Error)?.message ?? '内部错误' } } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if(process.env.LOCAL_PROXY_TOKEN && req.headers['x-furops-proxy-token']!==process.env.LOCAL_PROXY_TOKEN)throw new AppError('SCOPE_DENIED','请从工作台页面访问',{httpStatus:403});
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/input') {
      const body = await readJson(req);
      const r = app.service.submit({ text: body?.text, targetItemId: body?.targetItemId ?? null, idempotencyKey: body?.idempotencyKey ?? null, boundCatId: body?.boundCatId ?? null, mediaIds: body?.mediaIds ?? null });
      return json(res, 200, { input: { id: r.id, state: r.state, capturedAt: new Date().toISOString() } });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/v1/input/') && url.pathname.endsWith('/retry')) {
      const id = url.pathname.slice('/api/v1/input/'.length, -'/retry'.length);
      const state = await app.service.retryInput(id);
      return json(res, 200, { input: { id, state } });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/input/')) {
      const id = url.pathname.slice('/api/v1/input/'.length);
      const input = app.repo.getInput(id);
      if (!input) return json(res, 404, { error: { code: 'NOT_FOUND', message: '输入不存在' } });
      const intentItems = app.repo.getIntentItems(id).map((it: any) => ({
        id: it.id, commandType: it.command_type, proposedPayload: it.proposed_payload, state: it.state, missingFields: it.missing_fields, targetItemId: it.target_item_id,
      }));
      return json(res, 200, { input: { id: input.id, state: input.state, textBody: input.text_body, capturedAt: input.captured_at, updatedAt: input.updated_at }, intentItems });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/v1/records/')) {
      const id = url.pathname.slice('/api/v1/records/'.length);
      const body = await readJson(req);
      const version = Number(body?.version);
      if (!Number.isSafeInteger(version)) return json(res, 400, { error: { code: 'SCHEMA_INVALID', message: 'version 必须为整数' } });
      correctRecord(app.repo, id, { quantity: body?.quantity, amountFen: body?.amountFen, weightGram: body?.weightGram, text: body?.text, reason: body?.reason }, version);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/records/')) {
      const id = url.pathname.slice('/api/v1/records/'.length);
      const version = Number(url.searchParams.get('version'));
      if (!Number.isSafeInteger(version)) return json(res, 400, { error: { code: 'SCHEMA_INVALID', message: 'version 必须为整数' } });
      deleteRecord(app.repo, id, version);
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/todos') {
      return json(res, 200, { todos: computeTodos(app.db) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/health-records') {
      const body = await readJson(req);
      registerHealthRecord(app.repo, { catId: body?.catId, type: body?.type, date: body?.date, nextDueDate: body?.nextDueDate ?? null, note: body?.note ?? null });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = readFileSync(fileURLToPath(new URL('../../static/index.html', import.meta.url)), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return json(res, 404, { error: { code: 'NOT_FOUND', message: '临时界面未找到' } });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/cats') {
      return json(res, 200, { cats: listCatsSummary(app.db) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/cats/')) {
      const id = url.pathname.slice('/api/v1/cats/'.length);
      const detail = getCatDetail(app.db, id);
      if (!detail) return json(res, 404, { error: { code: 'NOT_FOUND', message: '猫咪不存在' } });
      return json(res, 200, detail);
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/cats') {
      const b = await readJson(req);
      return json(res, 200, createCat(app.repo, { name: b?.name, role: b?.role, sex: b?.sex ?? null, birthDate: b?.birthDate ?? null, motherId: b?.motherId ?? null, litterId: b?.litterId ?? null }));
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/v1/cats/')) {
      const id = url.pathname.slice('/api/v1/cats/'.length);
      const b = await readJson(req);
      const version = Number(b?.version);
      if (!Number.isSafeInteger(version)) return json(res, 400, { error: { code: 'SCHEMA_INVALID', message: 'version 必须为整数' } });
      editCat(app.repo, id, { name: b?.name, sex: b?.sex, birthDate: b?.birthDate }, version);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/litters') {
      return json(res, 200, { litters: app.repo.listLitters() });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/litters') {
      const b = await readJson(req);
      return json(res, 200, createLitter(app.repo, { motherId: b?.motherId, name: b?.name ?? null, birthDate: b?.birthDate ?? null }));
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/items') {
      return json(res, 200, { items: listItemsSummary(app.db) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/items') {
      const b = await readJson(req);
      return json(res, 200, createItem(app.repo, { name: b?.name, category: b?.category, quantity: Number(b?.quantity), unit: b?.unit ?? null, priceFen: b?.priceFen ?? null, expiryDate: b?.expiryDate ?? null, lowStockThreshold: b?.lowStockThreshold ?? null }));
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/v1/items/')) {
      const id = url.pathname.slice('/api/v1/items/'.length);
      const b = await readJson(req);
      const version = Number(b?.version);
      if (!Number.isSafeInteger(version)) return json(res, 400, { error: { code: 'SCHEMA_INVALID', message: 'version 必须为整数' } });
      editItem(app.repo, id, { name: b?.name, category: b?.category, quantity: b?.quantity !== undefined ? Number(b?.quantity) : undefined, unit: b?.unit, priceFen: b?.priceFen, expiryDate: b?.expiryDate, lowStockThreshold: b?.lowStockThreshold }, version);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/records') {
      return json(res, 200, { records: listRecords(app.db, { type: url.searchParams.get('type') ?? undefined, catId: url.searchParams.get('catId') ?? undefined, dateFrom: url.searchParams.get('dateFrom') ?? undefined, dateTo: url.searchParams.get('dateTo') ?? undefined }) });
    }
    if(req.method==='GET'&&url.pathname.startsWith('/api/v1/media/')){
      const id=url.pathname.slice('/api/v1/media/'.length);
      const media=app.db.prepare('SELECT relative_path,mime FROM media WHERE id=?').get(id) as any;
      if(!media)throw new AppError('NOT_FOUND','照片不存在',{httpStatus:404});
      const dir=resolve(process.env.DATA_DIR||'../data');const abs=resolve(dir,media.relative_path);
      if(!abs.startsWith(dir+sep))throw new AppError('SCOPE_DENIED','照片路径无效',{httpStatus:403});
      let bytes:Buffer;try{bytes=readFileSync(abs);}catch{throw new AppError('NOT_FOUND','照片文件不存在',{httpStatus:404});}
      res.writeHead(200,{'Content-Type':media.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});res.end(bytes);return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/media') {
      const b = await readJson(req, 14_100_000);
      const bytes = b?.data ? Buffer.from(b.data, 'base64') : new Uint8Array(0);
      return json(res, 200, saveMedia(app.repo, { mime: b?.mime, bytes }));
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/asr') {
      const audio = await readBody(req, 44 + 16000 * 60 * 2);
      const text = await transcribeWav(audio);
      return json(res, 200, { text });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: '未找到' } });
  } catch (e) {
    const { status, body } = toErrorBody(e);
    return json(res, status, body);
  }
});

server.listen(app.config.port, '127.0.0.1', () => {
  console.log('FurOps API 已启动：http://localhost:' + app.config.port + '（mock=' + app.config.useMockPlanner + '）');
});
