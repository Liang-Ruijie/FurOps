import { argon2id } from 'hash-wasm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Argon2id 口令哈希（纯 WASM，无原生模块，避免打包问题）。服务端仅存摘要。
const ARGON2 = { parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 };

// hash-wasm 的 WASM 实例非并发安全：串行化所有 argon2id 调用，避免并行测试/请求下哈希被破坏
let hashQueue: Promise<unknown> = Promise.resolve();
function runArgon2id(opts: any): Promise<string> {
  const result = hashQueue.then(() => argon2id(opts)) as Promise<string>;
  hashQueue = result.catch(() => {}); // 队列吞掉错误但保持后续继续
  return result;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await runArgon2id({ password, salt, ...ARGON2, outputType: 'hex' });
  return `$argon2id$m=${ARGON2.memorySize},t=${ARGON2.iterations},p=${ARGON2.parallelism}$${salt.toString('hex')}$${h}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    // ['', 'argon2id', 'm=...,t=...,p=...', saltHex, hashHex]
    const params = parts[2].split(',');
    const memorySize = parseInt(params[0].split('=')[1], 10);
    const iterations = parseInt(params[1].split('=')[1], 10);
    const parallelism = parseInt(params[2].split('=')[1], 10);
    const salt = Buffer.from(parts[3], 'hex');
    const expected = parts[4];
    const actual = await runArgon2id({ password, salt, memorySize, iterations, parallelism, hashLength: 32, outputType: 'hex' });
    return actual === expected;
  } catch { return false; }
}

// 会话：32 随机字节 token，服务端仅存 SHA-256 摘要
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: sha256(token) };
}
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
export function uuid(): string {
  return randomUUID();
}
export function nowIso(): string {
  return new Date().toISOString();
}
