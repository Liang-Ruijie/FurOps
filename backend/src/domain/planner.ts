import { createHash } from 'node:crypto';
import { AppError } from './errors.ts';
import { NoopBudgetTracker, type BudgetTracker } from './budget.ts';
import { parsePlan } from './schema.ts';
import { buildPlannerMessages } from './prompts/planner.ts';

export interface PlanResult { items: Array<Record<string, unknown>> }

export interface Planner {
  plan(input: { text: string; context: unknown; taskId?: string }): Promise<PlanResult>;
}

// 离线测试 / 未授权时用的 mock 规划器（不发起真实调用）
export class MockPlanner implements Planner {
  private fn: (input: { text: string; context: unknown; taskId?: string }) => PlanResult;
  constructor(fn: (input: { text: string; context: unknown; taskId?: string }) => PlanResult) { this.fn = fn; }
  async plan(input: { text: string; context: unknown; taskId?: string }): Promise<PlanResult> {
    return this.fn(input);
  }
}

export interface TransportResponse {
  status: number;
  body: unknown;
  usageInput?: number;
  usageOutput?: number;
  requestId?: string;
}

export interface ModelTransport {
  send(req: { model: string; messages: Array<{ role: string; content: string }>; maxOutputTokens?: number; signal?: AbortSignal }): Promise<TransportResponse>;
}

// 真实 OpenAI 兼容 HTTP 传输（原生 fetch）
export class HttpTransport implements ModelTransport {
  private apiKey: string;
  private baseUrl: string;
  constructor(apiKey: string, baseUrl: string) { this.apiKey = apiKey; this.baseUrl = baseUrl; }
  async send(req: { model: string; messages: Array<{ role: string; content: string }>; maxOutputTokens?: number; signal?: AbortSignal }): Promise<TransportResponse> {
    const resp = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: req.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: req.model, messages: req.messages, response_format: { type: 'json_object' }, max_tokens: req.maxOutputTokens ?? 1000, thinking: { type: 'disabled' } }),
    });
    const text = await resp.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = text; }
    const usage = (body as any)?.usage;
    const content = (body as any)?.choices?.[0]?.message?.content;
    let parsed: unknown = null;
    if (typeof content === 'string') { try { parsed = JSON.parse(content); } catch { parsed = content; } }
    return {
      status: resp.status,
      body: parsed ?? body,
      usageInput: Number(usage?.prompt_tokens ?? NaN),
      usageOutput: Number(usage?.completion_tokens ?? NaN),
      requestId: (resp.headers as any)?.get?.('x-request-id') ?? undefined,
    };
  }
}

interface PlannerOpts {
  apiKey: string;
  baseUrl: string;
  model: string;
  budget: BudgetTracker;
  transport?: ModelTransport;
  maxCalls?: number;
  deadlineMs?: number;
  taskId?: string;
  batchId?: string;
  maxOutputTokens?: number;
  rate?: { inputPerMillionFen: number; outputPerMillionFen: number };
}

// 受控 DeepSeek 规划器：真实调用及重试必须经过授权预算（Noop 仅配 mock，见 2-1/2-2 文档）
export class DeepSeekPlanner implements Planner {
  private opts: PlannerOpts;
  private transport: ModelTransport;
  constructor(opts: PlannerOpts) {
    if (opts.budget instanceof NoopBudgetTracker) {
      throw new AppError('BUDGET_BLOCKED', '真实模型调用未授权：需先授权并配置预算限额', { retryable: false, nextAction: '由产品经理授权后开启' });
    }
    this.opts = opts;
    this.transport = opts.transport ?? new HttpTransport(opts.apiKey, opts.baseUrl);
  }

  async plan(input: { text: string; context: unknown; taskId?: string }): Promise<PlanResult> {
    const { budget, model } = this.opts;
    const maxCalls = this.opts.maxCalls ?? 1;
    const deadlineMs = this.opts.deadlineMs ?? 45_000;
    const deadlineAt = Date.now() + deadlineMs;
    const hash = createHash('sha256').update(JSON.stringify(input,(_k,v)=>typeof v==='bigint'?Number(v):v)).digest('hex');
    const requestHash = this.opts.batchId ? `batch:${this.opts.batchId}:${hash}` : hash;
    const taskId = input.taskId ?? this.opts.taskId ?? hash;
    const messages = buildPlannerMessages(input);
    // UTF-8 字节数加消息框架余量，作为本轮中文短句的保守输入 token 上界。
    const inputUpper = Buffer.byteLength(JSON.stringify(messages),'utf8') + 256;
    const outputUpper = this.opts.maxOutputTokens ?? 1000;
    const rate = this.opts.rate ?? { inputPerMillionFen: 200, outputPerMillionFen: 800 };
    if(inputUpper > 16000 || !Number.isSafeInteger(outputUpper) || outputUpper < 1 || outputUpper > 2000 || !Object.values(rate).every(v=>Number.isFinite(v)&&v>0)) throw new AppError('BUDGET_BLOCKED','输入或费用上限不明确，停止调用');
    const reservedFen = Math.max(1,Math.ceil(inputUpper * rate.inputPerMillionFen / 1_000_000)+Math.ceil(outputUpper * rate.outputPerMillionFen / 1_000_000));

    let lastErr: string | undefined;
    for (let attempt = 1; attempt <= maxCalls; attempt++) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { lastErr = 'timeout'; break; }

      // 每次真实调用（含重试）都先预留预算
      const { callId } = budget.reserve({ provider: 'deepseek', model, capability: 'planner', requestHash, reservedFen, taskId, rateVersion: 'peak-20261108' });

      const controller = new AbortController();
      const abortTimer = setTimeout(()=>controller.abort(),remaining);
      try {
        const resp = await withTimeout(this.transport.send({ model, messages, maxOutputTokens: outputUpper, signal: controller.signal }), remaining);

        if (resp.status === 401 || resp.status === 403) { budget.settle(callId, 'failed', 0, undefined, undefined, 'peak-20261108', 'provider_' + resp.status); lastErr = 'provider_' + resp.status; break; }
        if (resp.status === 429 || resp.status >= 500) { budget.settle(callId, 'failed', 0, undefined, undefined, 'peak-20261108', 'provider_' + resp.status); lastErr = 'provider_' + resp.status; continue; }
        if (resp.body == null) { budget.settle(callId, 'unknown'); lastErr = 'unknown'; break; }

        const usageInput = Number(resp.usageInput);
        const usageOutput = Number(resp.usageOutput);
        const usageValid = Number.isFinite(usageInput) && Number.isFinite(usageOutput) && usageInput >= 0 && usageOutput >= 0;
        if (!usageValid) { budget.settle(callId, 'unknown'); lastErr = 'unknown'; break; }

        // 结构校验：不合法不重试（模型输出格式问题记失败，费用已产生则按 usage 结算）
        const actualFen = Math.ceil(usageInput / 1_000_000 * rate.inputPerMillionFen) + Math.ceil(usageOutput / 1_000_000 * rate.outputPerMillionFen);
        const parsed = parsePlan(resp.body);
        budget.settle(callId, parsed.ok ? 'succeeded' : 'failed', actualFen, { input: usageInput, output: usageOutput }, resp.requestId, 'peak-20261108', parsed.ok ? undefined : 'schema_invalid');
        if (!parsed.ok) { lastErr = 'schema_invalid'; break; }
        return { items: parsed.items };
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (msg === 'timeout') { budget.settle(callId, 'unknown'); lastErr = 'timeout'; break; }
        // 未分类异常：无法判断受理状态 → 按 unknown 保留预留并停止，不自动重发
        budget.settle(callId, 'unknown'); lastErr = 'unknown'; break;
      } finally { clearTimeout(abortTimer); }
    }
    throw new AppError('MODEL_TIMEOUT', '模型规划失败：' + (lastErr ?? '未知错误'), { retryable: false });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), Math.max(1, ms));
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
