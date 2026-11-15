// FurOps 数据库层：Node 内置 node:sqlite（同步 SQLite，WAL/FK/STRICT，BigInt 无损）
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.ts';

export type DB = DatabaseSync;

export function openDb(dbPath: string): DatabaseSync {
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { readBigInts: true }); // INTEGER 以 BigInt 返回
  try { db.exec('PRAGMA journal_mode = WAL'); }
  catch { /* 并发打开时可能短暂锁；已是 WAL 则后续写入自动继续 */ }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 100');
  return db;
}

// 有限短退避：SQLITE_BUSY 初次尝试 + 最多 3 次重试（100/250/500ms），仍失败 → 503
export function withBusyRetry<T>(fn: () => T): T {
  const backoff = [100, 250, 500];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/SQLITE_BUSY|database is locked/i.test(msg)) throw e;
      lastErr = e;
      if (attempt < 3) {
        const t0 = Date.now();
        while (Date.now() - t0 < backoff[attempt]) { /* busy-wait 保持同步语义 */ }
      }
    }
  }
  throw new AppError('STORAGE_BUSY', '数据库忙，请稍后重试', { retryable: true, nextAction: '原请求幂等键不变，稍后重试' });
}

// 事务助手（node:sqlite 无内置 transaction 包装）
export function inTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// run 返回的 changes 为 BigInt（readBigInts 模式），统一比较
export function changed(r: { changes: number | bigint }): boolean {
  return Number(r.changes) > 0;
}
