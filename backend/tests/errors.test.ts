import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/domain/errors.ts';

test('AppError httpStatus 映射', () => {
  assert.equal(new AppError('NOT_FOUND', 'x').httpStatus, 404);
  assert.equal(new AppError('SCHEMA_INVALID', 'x').httpStatus, 400);
  assert.equal(new AppError('SESSION_EXPIRED', 'x').httpStatus, 401);
  assert.equal(new AppError('SCOPE_DENIED', 'x').httpStatus, 403);
  assert.equal(new AppError('VERSION_CONFLICT', 'x').httpStatus, 409);
  assert.equal(new AppError('FILE_LIMIT', 'x').httpStatus, 413);
  assert.equal(new AppError('FILE_TYPE', 'x').httpStatus, 415);
  assert.equal(new AppError('NEEDS_INPUT', 'x').httpStatus, 422);
  assert.equal(new AppError('BUDGET_BLOCKED', 'x').httpStatus, 429);
  assert.equal(new AppError('MODEL_TIMEOUT', 'x').httpStatus, 503);
  assert.equal(new AppError('STORAGE_BUSY', 'x').httpStatus, 503);
  assert.equal(new AppError('STORAGE_FULL', 'x').httpStatus, 507);
});

test('toBody 统一结构', () => {
  const b = new AppError('VERSION_CONFLICT', '改了', { retryable: false, nextAction: '重载' }).toBody();
  assert.deepEqual(Object.keys(b), ['error']);
  assert.equal(b.error.code, 'VERSION_CONFLICT');
  assert.equal(b.error.message, '改了');
  assert.equal(b.error.retryable, false);
  assert.equal(b.error.nextAction, '重载');
});
