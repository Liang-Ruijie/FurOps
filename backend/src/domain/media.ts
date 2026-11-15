// 照片附件：只存本地，校验格式/类型/大小；不识图、不外发模型
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError } from './errors.ts';
import { uuid } from './auth.ts';
import type { Repo } from './repo.ts';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif':'heif' };

export function saveMedia(repo: Repo, file: { mime: string; bytes: Uint8Array }): { id: string; relativePath: string } {
  const ext = EXT[file.mime];
  if (!ext) throw new AppError('FILE_TYPE', '仅支持 jpg/png/heic/heif 图片', { httpStatus: 415 });
  if (file.bytes.byteLength > MAX_BYTES) throw new AppError('FILE_LIMIT', '图片过大（≤10MB）', { httpStatus: 413 });
  if (file.bytes.byteLength === 0) throw new AppError('FILE_LIMIT', '图片为空', { httpStatus: 400 });
  const b = file.bytes;
  const png = b.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v);
  const jpeg = b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  const heic = b.length >= 12 && Buffer.from(b.subarray(4,8)).toString('ascii') === 'ftyp' && ['heic','heix','hevc','hevx','mif1','msf1'].includes(Buffer.from(b.subarray(8,12)).toString('ascii'));
  if (!(file.mime === 'image/png' ? png : file.mime === 'image/jpeg' ? jpeg : heic)) {
    throw new AppError('FILE_TYPE', '文件内容与图片格式不匹配，请选择有效照片', { httpStatus: 415 });
  }
  const id = uuid();
  const relativePath = `media/${id}.${ext}`;
  const dataDir = process.env.DATA_DIR || resolve(process.cwd(), '../data');
  const abs = resolve(dataDir, relativePath);
  if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, file.bytes);
  repo.insertMedia({ id, relativePath, mime: file.mime, byteSize: file.bytes.byteLength });
  return { id, relativePath };
}
