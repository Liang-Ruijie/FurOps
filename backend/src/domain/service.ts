import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.ts';
import { uuid } from './auth.ts';
import type { Repo } from './repo.ts';
import type { Planner } from './planner.ts';
import { buildContext } from './memory.ts';
import { validateItem } from './schema.ts';
import { executeCommand, executeUseItem } from './records.ts';

export interface SubmitResult { id: string; state: string; replayed: boolean }

// 编排：提交 → 任务 → 拆解 → 校验 → 执行（含补充接续、幂等、重启续跑、写入与状态一致）
export function createService(db: DatabaseSync, repo: Repo, planner: Planner) {
  async function planOnce(input: any): Promise<void> {
    // 续跑：已有意图则不重复规划（重启后不重复生成已完成记录）
    if (repo.hasIntentItems(input.id)) return;
    const context = buildContext(db, input.text_body ?? '', input.target_item_id ?? null, input.bound_cat_id ?? null);
    const plan = await planner.plan({ text: input.text_body ?? '', context, taskId:input.id });
    repo.transaction(()=>{
    plan.items.forEach((raw, i) => {
      const v = validateItem(raw);
      if (v.ok) {
        repo.insertIntentItem({
          id: uuid(), inputId: input.id, ordinal: i,
          commandType: v.command.type, proposedPayload: JSON.stringify(v.command.payload),
          state: 'planned', missingFields: null, targetItemId: input.target_item_id ?? null,
        });
      } else {
        repo.insertIntentItem({
          id: uuid(), inputId: input.id, ordinal: i,
          commandType: null, proposedPayload: JSON.stringify(raw),
          state: 'failed', missingFields: JSON.stringify(v.errors), targetItemId: input.target_item_id ?? null,
        });
      }
    });
    });
  }

  function executePending(inputId: string): void {
    // planned = 新意图；pending = 2-2 遗留的待执行用药意图，一并接续处理（只执行一次）
    for (const it of repo.getIntentItems(inputId)) {
      if (it.state !== 'planned' && it.state !== 'pending') continue;
      const type = it.command_type as string;
      const payload = JSON.parse(it.proposed_payload as string);
      if (type === 'clarify') {
        repo.updateIntentItemState(it.id, 'needs_input', JSON.stringify((payload as any).missingFields ?? []));
        continue;
      }
      if (type === 'use_item') {
        try {
          repo.transaction(() => {
            executeUseItem(repo, payload, inputId);
            repo.updateIntentItemState(it.id, 'completed');
          });
        } catch (e) {
          const err = e as AppError;
          if (err.code === 'NEEDS_INPUT') {
            repo.updateIntentItemState(it.id, 'needs_input', JSON.stringify((err.details ?? []).map((d: any) => d.reason==='unit_mismatch'?'unit':d.field)));
          } else {
            repo.updateIntentItemState(it.id, 'failed', JSON.stringify([(e as Error).message]));
          }
        }
        continue;
      }
      try {
        // 记录写入与状态更新同一事务：要么都成功、要么都回滚（中断恢复不产生半完成态、不重复记录）
        repo.transaction(() => {
          executeCommand(repo, { type: type as any, payload }, inputId);
          repo.updateIntentItemState(it.id, 'completed');
        });
      } catch (e) {
        const err=e as AppError;
        if(err.code==='NEEDS_INPUT')repo.updateIntentItemState(it.id,'needs_input',JSON.stringify((err.details??[]).map(d=>d.field)));
        else repo.updateIntentItemState(it.id, 'failed', JSON.stringify([(e as Error).message]));
      }
    }
  }

  function finalize(inputId: string): string {
    const items = repo.getIntentItems(inputId);
    if (items.some(i => i.state === 'needs_input')) return 'needs_input';
    if (items.some(i => i.state === 'failed')) return 'failed';
    if (items.some(i => i.state === 'pending')) return 'pending';
    return 'completed';
  }

  // 补充接续：补充处理完成后，同步结束原待补事项（needs_input → completed），并重算原输入状态
  function resolveTargetItem(input: any, finalState: string): void {
    if (!input.target_item_id) return;
    if (finalState === 'failed' || finalState === 'needs_input'||repo.getIntentItems(input.id).length===0) return;
    const target = repo.getIntentItem(input.target_item_id);
    if (target && target.state === 'needs_input') {
      let known:Record<string,any>={};
      try{const raw=JSON.parse(target.proposed_payload||'{}');known=raw.partialPayload||raw;}catch{/* 无已知字段时仍由补充意图决定 */}
      const expectedType=known.commandType||(target.command_type!=='clarify'?target.command_type:null);
      const matches=repo.getIntentItems(input.id).some(it=>{
        if(it.state!=='completed'||(expectedType&&it.command_type!==expectedType))return false;
        const p=JSON.parse(it.proposed_payload||'{}');
        return ['catId','itemId','motherId','litterId'].every(key=>!known[key]||known[key]===p[key]);
      });
      if(!matches)return; // 明确改说别的对象可入档，但不能抹掉原猫尚未补齐的事项。

      repo.updateIntentItemState(target.id, 'completed');
      repo.updateInputState(target.input_id, finalize(target.input_id));
    }
  }

  return {
    submit(input: { text: string; targetItemId?: string | null; idempotencyKey?: string | null; boundCatId?: string | null; mediaIds?: string[] | null }): SubmitResult {
      const text = (input.text ?? '').trim();
      if (!text) throw new AppError('SCHEMA_INVALID', 'text 不能为空', { httpStatus: 400 });
      if (input.idempotencyKey) {
        const existing = repo.getInputByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          if (existing.text_body === text&&(existing.bound_cat_id??null)===(input.boundCatId??null)&&(existing.target_item_id??null)===(input.targetItemId??null)&&JSON.stringify(JSON.parse(existing.media_ids||'[]'))===JSON.stringify(input.mediaIds??[])) return { id: existing.id, state: existing.state, replayed: true };
          throw new AppError('IDEMPOTENCY_CONFLICT', '相同幂等键但内容不同', { httpStatus: 409 });
        }
      }
      if (input.targetItemId && !repo.getIntentItem(input.targetItemId)) {
        throw new AppError('NOT_FOUND', '关联的待补事项不存在', { httpStatus: 404 });
      }
      if (input.boundCatId && !repo.getCat(input.boundCatId)) {
        throw new AppError('NOT_FOUND', '绑定的猫不存在', { httpStatus: 404 });
      }
      if(input.mediaIds!=null && (!Array.isArray(input.mediaIds)||input.mediaIds.length>8||!input.mediaIds.every(id=>typeof id==='string'&&db.prepare('SELECT id FROM media WHERE id=?').get(id))))throw new AppError('SCHEMA_INVALID','附件不存在或超过8张，请重新选择照片',{httpStatus:400});
      const id = uuid();
      repo.transaction(() => {
        repo.insertInput({ id, textBody: text, state: 'received', targetItemId: input.targetItemId ?? null, idempotencyKey: input.idempotencyKey ?? null, boundCatId: input.boundCatId ?? null, mediaIds: input.mediaIds?.length ? JSON.stringify(input.mediaIds) : null });
        repo.insertTask({ id: uuid(), inputId: id, kind: 'plan_input', state: 'queued' });
      });
      return { id, state: 'received', replayed: false };
    },

    async processInput(inputId: string): Promise<string> {
      const input = repo.getInput(inputId);
      if (!input) throw new AppError('NOT_FOUND', '输入不存在');
      repo.updateInputState(inputId, 'processing');
      try{await planOnce(input);}catch(e){repo.updateInputState(inputId,'failed');throw e;}
      executePending(inputId);
      const final = finalize(inputId);
      repo.updateInputState(inputId, final);
      resolveTargetItem(input, final);
      return final;
    },

    async processNextTask(workerId: string): Promise<boolean> {
      const task = repo.claimTask(workerId, 30_000);
      if (!task) return false;
      try {
        if (task.input_id) await this.processInput(task.input_id);
        repo.completeTask(task.id, task.lease_token, task.input_id);
      } catch (e) {
        repo.failTask(task.id, task.lease_token, String((e as Error)?.message ?? e).slice(0, 200));
      }
      return true;
    },

    // 整理失败后在原任务上重试：重置失败意图为 planned 并重新排队，不重新提交成另一笔
    async retryInput(inputId: string): Promise<string> {
      const input = repo.getInput(inputId);
      if (!input) throw new AppError('NOT_FOUND', '输入不存在', { httpStatus: 404 });
      if (input.state !== 'failed') throw new AppError('SCHEMA_INVALID', '只有失败的输入才能重试', { httpStatus: 400 });
      repo.transaction(() => {
        repo.updateInputState(inputId, 'received');
        for (const it of repo.getIntentItems(inputId)) {
          if (it.state === 'failed') repo.updateIntentItemState(it.id, 'planned', null);
        }
        repo.insertTask({ id: uuid(), inputId, kind: 'plan_input', state: 'queued' });
      });
      return 'received';
    },
  };
}
