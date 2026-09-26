/**
 * 统一错误码 —— 对应 DESIGN.md §6.1。
 *
 * 铁律:`NOT_FOUND` 刻意不区分「不存在」与「存在但无权访问」。
 * 否则可以通过错误码枚举出别人的文档 ID(违反 §5.3「最小可见」)。
 */

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误码 → HTTP 状态码。 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
});

/**
 * 默认中文文案。`INTERNAL_ERROR` 的文案是给用户看的,
 * 内部细节只写日志、不进响应体。
 */
export const DEFAULT_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  UNAUTHORIZED: '请先登录',
  FORBIDDEN: '你没有执行该操作的权限',
  NOT_FOUND: '页面不存在或你没有访问权限',
  VALIDATION_FAILED: '请求参数不正确',
  VERSION_CONFLICT: '该页面已被他人修改,请刷新后重试',
  RATE_LIMITED: '操作过于频繁,请稍后再试',
  INTERNAL_ERROR: '服务器内部错误',
});

/** 统一错误响应体。前端 `lib/api.ts` 只需按这一种形状解析。 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** 仅 VALIDATION_FAILED 等场景携带;不保证存在。 */
    details?: unknown;
  };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** 构造统一错误体,保证形状永不漂移。 */
export function buildErrorBody(code: ErrorCode, message?: string, details?: unknown): ApiErrorBody {
  const body: ApiErrorBody = {
    error: {
      code,
      message: message ?? DEFAULT_ERROR_MESSAGES[code],
    },
  };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}
