import { openDb } from './domain/db.ts';
import { migrate } from './domain/migrate.ts';
import { createRepo } from './domain/repo.ts';
import { createService } from './domain/service.ts';
import { MockPlanner, DeepSeekPlanner, type Planner, type PlanResult } from './domain/planner.ts';
import { SqliteBudgetTracker } from './domain/budget.ts';
import { loadConfig, type Config } from './config.ts';
import { todayShanghai } from './domain/time.ts';

// 开发/验收用 mock 规划器：有绑定猫 + 数字时输出体重意图（仅用于临时界面演示绑定流程，不代表真实 AI 能力）
function defaultMockPlan(input: { text: string; context: any }): PlanResult {
  const boundCat = input.context?.boundCat;
  const m = input.text.match(/^\s*(\d+)\s*(?:克|g)?\s*$/);
  if (boundCat && m) {
    const weightGram = Math.round(Number(m[1]));
    if (Number.isSafeInteger(weightGram) && weightGram > 0) {
      return { items: [{ commandType: 'weight', catId: boundCat.id, date: todayShanghai(), weightGram }] };
    }
  }
  return { items: [] };
}

// 装配应用：mock 规划器（未授权/离线）或真实 DeepSeek 规划器（已授权 + 正限额预算）
export function createApp(config: Config = loadConfig()) {
  const db = openDb(config.dbPath);
  migrate(db);
  const repo = createRepo(db);

  let planner: Planner;
  if (config.useMockPlanner) {
    planner = new MockPlanner(defaultMockPlan);
  } else {
    if (!config.budgetLimits) throw new Error('预算未授权，禁止真实模型调用');
    const budget = new SqliteBudgetTracker({ db, limits: config.budgetLimits });
    planner = new DeepSeekPlanner({ apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: config.deepseekModel, budget });
  }

  const service = createService(db, repo, planner);
  return { db, repo, planner, service, config };
}
