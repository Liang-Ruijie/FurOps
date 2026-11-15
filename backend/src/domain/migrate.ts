import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.ts';

// 12 张表 DDL（骨架开发计划 11 表 + budget_period；model_call 对齐预算机制补列、job_id→task_id；task 补 result_ref/error_code；input_record 补 target_item_id/idempotency_key）
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS cat (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('male','mother','kitten')),
    name TEXT NOT NULL,
    sex TEXT,
    birth_date TEXT,
    mother_id TEXT REFERENCES cat(id),
    litter_id TEXT REFERENCES litter(id),
    father_id TEXT REFERENCES cat(id),
    avatar_path TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS litter (
    id TEXT PRIMARY KEY,
    mother_id TEXT NOT NULL REFERENCES cat(id),
    name TEXT,
    birth_date TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS item (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('food','litter','medicine','toy','other')),
    quantity REAL NOT NULL DEFAULT 0,
    unit TEXT,
    price_fen INTEGER,
    expiry_date TEXT,
    photo_path TEXT,
    low_stock_threshold REAL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS record (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('weight','observation','expense','use_item','item_stock')),
    cat_id TEXT REFERENCES cat(id),
    item_id TEXT REFERENCES item(id),
    business_date TEXT NOT NULL,
    weight_gram INTEGER,
    text TEXT,
    amount_fen INTEGER,
    quantity REAL,
    unit_price_fen INTEGER,
    reason TEXT,
    source_input_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS health_record (
    id TEXT PRIMARY KEY,
    cat_id TEXT NOT NULL REFERENCES cat(id),
    type TEXT NOT NULL CHECK(type IN ('vaccine','deworm')),
    date TEXT NOT NULL,
    next_due_date TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS input_record (
    id TEXT PRIMARY KEY,
    text_body TEXT,
    media_ids TEXT,
    state TEXT NOT NULL,
    target_item_id TEXT,
    idempotency_key TEXT,
    bound_cat_id TEXT,
    captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS intent_item (
    id TEXT PRIMARY KEY,
    input_id TEXT NOT NULL REFERENCES input_record(id),
    ordinal INTEGER NOT NULL,
    command_type TEXT,
    proposed_payload TEXT,
    state TEXT NOT NULL,
    missing_fields TEXT,
    target_item_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY,
    input_id TEXT REFERENCES input_record(id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    lease_token TEXT,
    lease_until TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    result_ref TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS model_call (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    capability TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','succeeded','failed','unknown')),
    request_hash TEXT NOT NULL,
    reserved_fen INTEGER NOT NULL,
    actual_fen INTEGER,
    usage_input INTEGER,
    usage_output INTEGER,
    provider_request_id TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS budget_period (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL,
    provider TEXT NOT NULL,
    limit_fen INTEGER NOT NULL,
    reserved_fen INTEGER NOT NULL DEFAULT 0,
    spent_fen INTEGER NOT NULL DEFAULT 0,
    UNIQUE(period, provider)
  )`,

  `CREATE TABLE IF NOT EXISTS app_config (
    id TEXT PRIMARY KEY,
    ai_enabled INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model_name TEXT,
    task_limit_fen INTEGER,
    day_limit_fen INTEGER,
    month_limit_fen INTEGER,
    reminder_advance_days INTEGER NOT NULL DEFAULT 30,
    updated_at TEXT NOT NULL
  )`,
];

// 幂等补列：已有库（阶段 2-1 建的）缺列时 ALTER 加上
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrate(db: DatabaseSync): number {
  for (const sql of DDL) db.exec(sql);
  // 阶段 2-2/2-4 补列（幂等）
  ensureColumn(db, 'input_record', 'target_item_id', 'target_item_id TEXT');
  ensureColumn(db, 'input_record', 'idempotency_key', 'idempotency_key TEXT');
  ensureColumn(db, 'input_record', 'bound_cat_id', 'bound_cat_id TEXT');
  // 同次发送去重：idempotency_key 唯一（NULL 不受约束）
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_input_idempotency ON input_record(idempotency_key) WHERE idempotency_key IS NOT NULL');
  return DDL.length;
}

// CLI 入口：node src/domain/migrate.ts（重复执行幂等）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath = process.env.DB_PATH || '../data/furops.db';
  const db = openDb(dbPath);
  const n = migrate(db);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
  console.log(`迁移完成：${n} 张表就绪（${dbPath}）`);
  console.log(tables.join(', '));
  db.close();
}
