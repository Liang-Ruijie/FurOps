// 应用配置：读环境变量。预算授权规则：AI_BUDGET_AUTHORIZED=1 才允许真实模型调用。
export interface Config {
  dbPath: string;
  port: number;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  budgetAuthorized: boolean;
  budgetLimits: { taskLimitFen: number; dayLimitFen: number; monthLimitFen: number } | null;
  useMockPlanner: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authorized = env.AI_BUDGET_AUTHORIZED === '1';
  const limits = {
    taskLimitFen: Number(env.TASK_LIMIT_FEN ?? 0),
    dayLimitFen: Number(env.DAY_LIMIT_FEN ?? 0),
    monthLimitFen: Number(env.MONTH_LIMIT_FEN ?? 0),
  };
  const forceMock = env.MOCK_PLANNER === '1';
  return {
    dbPath: env.DB_PATH || '../data/furops.db',
    port: Number(env.PORT || 3000),
    deepseekApiKey: env.DEEPSEEK_API_KEY || '',
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    budgetAuthorized: authorized,
    budgetLimits: authorized ? limits : null,
    // 未授权或显式要求 mock 时用 mock 规划器（不发起真实调用）；填 Key 不等于授权。
    useMockPlanner: forceMock || !authorized,
  };
}
