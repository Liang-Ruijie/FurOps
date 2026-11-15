import { createApp } from '../app.ts';

const app = createApp();
const WORKER_ID = 'worker-' + process.pid;
const POLL_MS = 400;

async function loop(): Promise<void> {
  for (;;) {
    try {
      await app.service.processNextTask(WORKER_ID);
    } catch (e) {
      console.error('[worker]', e);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

console.log('FurOps worker 已启动（workerId=' + WORKER_ID + '）');
loop();
