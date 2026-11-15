// FurOps 统一错误结构（契约：{error:{code,message,retryable,nextAction,requestId,details?}}）
export type ErrorCode =
  | 'SCHEMA_INVALID' | 'SESSION_EXPIRED' | 'SCOPE_DENIED' | 'NOT_FOUND'
  | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'CONFIRMATION_STALE'
  | 'FILE_LIMIT' | 'FILE_TYPE' | 'NEEDS_INPUT' | 'DEPENDENCY'
  | 'BUDGET_BLOCKED' | 'RATE_LIMIT' | 'MODEL_TIMEOUT' | 'STORAGE_BUSY'
  | 'STORAGE_FULL' | 'NOT_INITIALIZED' | 'ALREADY_INITIALIZED' | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN_ORIGIN' | 'FORBIDDEN_HOST' | 'CSRF_INVALID' | 'UNAUTHORIZED'
  | 'ASR_CONFIG' | 'ASR_QUOTA' | 'ASR_PROVIDER' | 'ASR_RESPONSE' | 'ASR_EMPTY';

export class AppError extends Error {
  code: ErrorCode;
  retryable: boolean;
  nextAction: string;
  requestId: string;
  details?: Array<{ field: string; reason: string }>;
  httpStatus: number;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; nextAction?: string; requestId?: string; details?: Array<{ field: string; reason: string }>; httpStatus?: number } = {}) {
    super(message);
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.nextAction = opts.nextAction ?? '';
    this.requestId = opts.requestId ?? '';
    this.details = opts.details;
    this.httpStatus = opts.httpStatus ?? statusFor(code);
  }

  toBody() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable, nextAction: this.nextAction, requestId: this.requestId, details: this.details } };
  }
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'SCHEMA_INVALID': return 400;
    case 'SESSION_EXPIRED': case 'INVALID_CREDENTIALS': case 'UNAUTHORIZED': return 401;
    case 'SCOPE_DENIED': case 'FORBIDDEN_ORIGIN': case 'FORBIDDEN_HOST': case 'CSRF_INVALID': return 403;
    case 'NOT_FOUND': return 404;
    case 'VERSION_CONFLICT': case 'IDEMPOTENCY_CONFLICT': case 'CONFIRMATION_STALE': case 'ALREADY_INITIALIZED': return 409;
    case 'FILE_LIMIT': return 413;
    case 'FILE_TYPE': return 415;
    case 'NEEDS_INPUT': case 'DEPENDENCY': case 'NOT_INITIALIZED': return 422;
    case 'BUDGET_BLOCKED': case 'RATE_LIMIT': return 429;
    case 'ASR_CONFIG': case 'MODEL_TIMEOUT': case 'STORAGE_BUSY': return 503;
    case 'ASR_QUOTA': return 403;
    case 'ASR_PROVIDER': case 'ASR_RESPONSE': return 502;
    case 'ASR_EMPTY': return 422;
    case 'STORAGE_FULL': return 507;
    default: return 500;
  }
}
