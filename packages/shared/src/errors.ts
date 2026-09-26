/**
 * 统一错误码 —— 对应 DESIGN.md §6.1。
 *
 * ⚠️ **v2.0 起不再用 `NOT_FOUND` 掩盖「无权访问」。**
 * 读是对所有登录用户开放的(§5.3 规则一),不存在"存在但读不到"的资源,
 * 所以没有什么需要掩盖。写操作被拒时回 `FORBIDDEN` 是更有用的回应 ——
 * 用户需要知道"东西在那儿,只是你不能改",而不是被误导成"它不存在"。
 *
 * (v1.x 那条"用 404 掩盖存在性、以防枚举别人文档 ID"的理由,在新模型下不再成立。)
 */

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  /**
   * 必须先改密(v2.2)。
   *
   * 单独一个码而不是复用 FORBIDDEN,是因为前端需要**据此跳转改密页** ——
   * 如果混在通用 403 里,前端只能显示一句"没有权限",用户会卡死。
   * 注意:这只是体验;真正的拦截在服务端守卫里(§6.1.2)。
   */
  'PASSWORD_CHANGE_REQUIRED',
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
  PASSWORD_CHANGE_REQUIRED: 403,
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
  NOT_FOUND: '内容不存在',
  VALIDATION_FAILED: '请求参数不正确',
  VERSION_CONFLICT: '该内容已被他人修改,请刷新后重试',
  PASSWORD_CHANGE_REQUIRED: '请先修改初始密码',
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
