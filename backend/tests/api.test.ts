import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));

test('API：提交/幂等/查询/404（mock 规划器，不调真实模型）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'furops-api-'));
  const port = 3200 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DB_PATH: join(tmp, 't.db'), PORT: String(port), MOCK_PLANNER: '1' },
    stdio: 'ignore',
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  try {
    assert.ok(ready, '服务未就绪');

    const r1 = await fetch(`http://127.0.0.1:${port}/api/v1/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '红圈82克', idempotencyKey: 'k1' }),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json() as any;
    assert.ok(j1.input.id);

    const r2 = await fetch(`http://127.0.0.1:${port}/api/v1/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '红圈82克', idempotencyKey: 'k1' }),
    });
    const j2 = await r2.json() as any;
    assert.equal(j2.input.id, j1.input.id); // 幂等

    const r3 = await fetch(`http://127.0.0.1:${port}/api/v1/input/${j1.input.id}`);
    assert.equal(r3.status, 200);
    const j3 = await r3.json() as any;
    assert.equal(j3.input.id, j1.input.id);

    const r4 = await fetch(`http://127.0.0.1:${port}/api/v1/input/nonexistent`);
    assert.equal(r4.status, 404);
  } finally {
    child.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  }
});
