import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.ts';

// 预算预留/结算分离（从旧 adapter.ts 的 SqliteBudgetTracker 抽出；单用户去掉 workspace，job_id→task_id）
export interface BudgetTracker {
  reserve(req: { provider: string; model: string; capability: string; requestHash: string; reservedFen: number; taskId: string; rateVersion: string }): { callId: string };
  settle(callId: string, state: 'succeeded' | 'failed' | 'unknown', actualFen?: number, usage?: { input: number; output: number }, requestId?: string, rateVersion?: string, errorCode?: string): void;
}

export class NoopBudgetTracker implements BudgetTracker {
  reserve(_req: { provider: string; model: string; capability: string; requestHash: string; reservedFen: number; taskId: string; rateVersion: string }): { callId: string } { return { callId: randomUUID() }; }
  settle(_callId: string, _state?: 'succeeded' | 'failed' | 'unknown', _actualFen?: number, _usage?: { input: number; output: number }, _requestId?: string, _rateVersion?: string, _errorCode?: string): void {}
}

export interface BudgetRepo {
  db: DatabaseSync;
  limits: { taskLimitFen: number; dayLimitFen: number; monthLimitFen: number; batchMaxCalls?: number; batchId?: string; batchFeeLimitFen?: number };
}

export class SqliteBudgetTracker implements BudgetTracker {
  private repo: BudgetRepo;
  constructor(repo: BudgetRepo) { this.repo = repo; }

  private static dayOf(iso: string): string { return 'day:' + iso.slice(0, 10); }
  private static monthOf(iso: string): string { return 'month:' + iso.slice(0, 7); }
  private static batchIdOf(requestHash: string): string | null {
    if (!requestHash.startsWith('batch:')) return null;
    const rest = requestHash.slice(6);
    const idx = rest.indexOf(':');
    return idx >= 0 ? rest.slice(0, idx) : rest;
  }

  // UPSERT 周期限额：已存在则更新 limit_fen（保留 reserved/spent，不清零占额）
  private ensurePeriod(provider: string, period: string, limit: number): void {
    const existing = this.repo.db.prepare('SELECT id, reserved_fen, spent_fen FROM budget_period WHERE period=? AND provider=?').get(period, provider) as any;
    if (existing) {
      const floor = Number(existing.reserved_fen) + Number(existing.spent_fen);
      this.repo.db.prepare('UPDATE budget_period SET limit_fen=? WHERE id=?').run(Math.max(limit, floor), existing.id);
    } else {
      this.repo.db.prepare('INSERT INTO budget_period(id,period,provider,limit_fen,reserved_fen,spent_fen) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), period, provider, limit, 0, 0);
    }
  }

  reserve(req: { provider: string; model: string; capability: string; requestHash: string; reservedFen: number; taskId: string; rateVersion: string }): { callId: string } {
    const L = this.repo.limits;

    // 入口校验：必需限额（任务/日/月）必须为正的安全整数；未配置/为 0/负数/非整数 → 拒绝（预算关闭或未授权）
    const requiredLimits: Array<[string, number]> = [
      ['taskLimitFen', L.taskLimitFen],
      ['dayLimitFen', L.dayLimitFen],
      ['monthLimitFen', L.monthLimitFen],
    ];
    for (const [name, v] of requiredLimits) {
      if (!Number.isSafeInteger(v) || v <= 0) {
        throw new AppError('BUDGET_BLOCKED', `预算限额未配置或非法（${name}），模型调用已阻止`, { retryable: false, nextAction: '由产品经理授权后填写正整数限额再开启' });
      }
    }
    // 预留金额必须为正的安全整数（分）
    if (!Number.isSafeInteger(req.reservedFen) || req.reservedFen <= 0) {
      throw new AppError('BUDGET_BLOCKED', '预留金额必须为正整数（分）', { retryable: false });
    }

    const unresolved=this.repo.db.prepare("SELECT id FROM model_call WHERE state='unknown' OR (state='reserved' AND request_hash LIKE 'batch:%') LIMIT 1").get();
    if(unresolved)throw new AppError('BUDGET_BLOCKED','有费用或结果尚未核实的调用，本轮停止发起新调用');
    const nowIso = new Date().toISOString();
    const day = SqliteBudgetTracker.dayOf(nowIso);
    const mon = SqliteBudgetTracker.monthOf(nowIso);
    const callId = randomUUID();
    this.repo.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensurePeriod(req.provider, day, L.dayLimitFen);
      this.ensurePeriod(req.provider, mon, L.monthLimitFen);

      // 批次（稳定 batchId）：跨轮次/重启共享额度，覆盖 App/Worker/补问/重试
      const batchId = SqliteBudgetTracker.batchIdOf(req.requestHash);
      if (batchId && L.batchFeeLimitFen != null) {
        this.ensurePeriod(req.provider, 'batch:' + batchId, L.batchFeeLimitFen);
        if (L.batchMaxCalls != null && L.batchMaxCalls > 0) {
          const calls = this.repo.db.prepare("SELECT COUNT(*) n FROM model_call WHERE request_hash LIKE 'batch:' || ? || ':%'").get(batchId) as any;
          if (Number(calls.n) >= L.batchMaxCalls) throw new Error('批次调用次数已耗尽');
        }
        const batchRow = this.repo.db.prepare('SELECT reserved_fen, spent_fen FROM budget_period WHERE period=? AND provider=?').get('batch:' + batchId, req.provider) as any;
        if (Number(batchRow.reserved_fen) + Number(batchRow.spent_fen) + req.reservedFen > L.batchFeeLimitFen) throw new Error('批次费用已耗尽');
      }

      // 任务维度累计（避免重复计费式占额）：
      // reserved/unknown 按预留计，succeeded 按实际费用计，failed 不计
      const task = this.repo.db.prepare("SELECT COALESCE(SUM(CASE WHEN state IN ('reserved','unknown') THEN reserved_fen WHEN state IN ('succeeded','failed') THEN COALESCE(actual_fen,0) ELSE 0 END),0) committed FROM model_call WHERE task_id=?").get(req.taskId) as any;
      if (Number(task.committed) + req.reservedFen > L.taskLimitFen) throw new Error('任务预算不足');

      for (const p of [{ period: day, limit: L.dayLimitFen }, { period: mon, limit: L.monthLimitFen }]) {
        const row = this.repo.db.prepare('SELECT reserved_fen, spent_fen FROM budget_period WHERE period=? AND provider=?').get(p.period, req.provider) as any;
        if (Number(row.reserved_fen) + Number(row.spent_fen) + req.reservedFen > p.limit) throw new Error('周期预算不足');
      }

      this.repo.db.prepare('INSERT INTO model_call(id,task_id,provider,model_name,capability,state,request_hash,reserved_fen,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(callId, req.taskId, req.provider, req.model, req.capability, 'reserved', req.requestHash, req.reservedFen, 'rate_version=' + req.rateVersion, nowIso);

      for (const p of [day, mon]) {
        this.repo.db.prepare('UPDATE budget_period SET reserved_fen=reserved_fen+? WHERE period=? AND provider=?').run(req.reservedFen, p, req.provider);
      }
      if (batchId && L.batchFeeLimitFen != null) {
        this.repo.db.prepare('UPDATE budget_period SET reserved_fen=reserved_fen+? WHERE period=? AND provider=?').run(req.reservedFen, 'batch:' + batchId, req.provider);
      }

      this.repo.db.exec('COMMIT');
    } catch (e) {
      this.repo.db.exec('ROLLBACK');
      throw e;
    }
    return { callId };
  }

  settle(callId: string, state: 'succeeded' | 'failed' | 'unknown', actualFen = 0, usage?: { input: number; output: number }, requestId?: string, rateVersion?: string, errorCode?: string): void {
    const c = this.repo.db.prepare('SELECT reserved_fen, provider, state, created_at, request_hash FROM model_call WHERE id=?').get(callId) as any;
    if (!c || c.state !== 'reserved') return; // 幂等：已结算不重复

    // 使用预留时绑定的日/月周期（created_at），避免跨午夜/跨月释放到错误周期
    const day = SqliteBudgetTracker.dayOf(c.created_at);
    const mon = SqliteBudgetTracker.monthOf(c.created_at);
    const batchId = SqliteBudgetTracker.batchIdOf(c.request_hash || '');
    const rv = rateVersion || 'p2';

    this.repo.db.exec('BEGIN IMMEDIATE');
    try {
      if (state === 'unknown') {
        // 费用未知：保留预留，actual_fen 保持 NULL，标记待核对
        this.repo.db.prepare('UPDATE model_call SET state=?, actual_fen=NULL, usage_input=?, usage_output=?, provider_request_id=?, error_code=? WHERE id=?')
          .run('unknown', usage?.input ?? null, usage?.output ?? null, requestId ?? null, 'pending_review;rate_version=' + rv, callId);
        this.repo.db.exec('COMMIT');
        return;
      }

      const err = errorCode ? `${errorCode};rate_version=${rv}` : `rate_version=${rv}`;
      this.repo.db.prepare('UPDATE model_call SET state=?, actual_fen=?, usage_input=?, usage_output=?, provider_request_id=?, error_code=? WHERE id=?')
        .run(state, actualFen, usage?.input ?? null, usage?.output ?? null, requestId ?? null, err, callId);

      for (const p of [day, mon]) {
        if (state === 'succeeded'||actualFen>0) {
          this.repo.db.prepare('UPDATE budget_period SET reserved_fen=reserved_fen-?, spent_fen=spent_fen+? WHERE period=? AND provider=?').run(Number(c.reserved_fen), actualFen, p, c.provider);
        } else {
          this.repo.db.prepare('UPDATE budget_period SET reserved_fen=reserved_fen-? WHERE period=? AND provider=?').run(Number(c.reserved_fen), p, c.provider);
        }
      }
      if (batchId) {
        if (state === 'succeeded'||actualFen>0) {
          this.repo.db.prepare('UPDATE budget_period SET reserved_fen=reserved_fen-?, spent_fen=spent_fen+? WHERE period=? AND provider=?').run(Number(c.reserved_fen), actualFen, 'batch:' + batchId, c.provider);
        } else {
          this.repo.db.prepare('UPDATE budget_period SET reserved_fen=reserved_fen-? WHERE period=? AND provider=?').run(Number(c.reserved_fen), 'batch:' + batchId, c.provider);
        }
      }

      this.repo.db.exec('COMMIT');
    } catch (e) {
      this.repo.db.exec('ROLLBACK');
      throw e;
    }
  }
}
