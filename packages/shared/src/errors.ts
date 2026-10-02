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
   * ⚠️ 这里曾经有 `PASSWORD_CHANGE_REQUIRED`(v2.2 引入),**已删除**。
   *
   * 它的来历:v2.2 的首次登录**先发会话**,再由守卫把业务接口拦成
   * 「403 请先改密」。v2.4 把首登改成**根本不建立会话**之后,这条路径就不存在了 ——
   * 未改密的人对任何业务接口而言就是未登录(**401**),
   * 前端靠登录响应里的 `kind: 'password-change-required'` 跳改密页,不靠错误码。
   *
   * 删掉而不是留着,是因为**一个没有生产者的错误码就是死开关**:
   * 前端完全可以针对它写一条分支,而那条分支永远不会被执行 ——
   * 这比没有这个码更难查。(`seed-dev.mjs` 里那条守着 403 的旧断言就是这么暴露的。)
   */
  /**
   * 请求体超过上限(HTTP **413**)。
   *
   * ⚠️ v4.9 新增。此前没有这个码,而 `AllExceptionsFilter` 把**所有**无法识别的
   * 4xx 都兜底成 `VALIDATION_FAILED` —— 于是"上传超限"返回的是
   * **HTTP 413 却带 `VALIDATION_FAILED` 码**,而 §6.1 明确定义
   * `VALIDATION_FAILED = 400`。状态码与错误码**互相矛盾**,
   * 前端按码分支就永远走不到"文件太大"那条提示(它只在 400 分支里)。
   *
   * 单独立一个码,而不是让 413 去借 400 —— 因为它是**独立且可行动**的一类:
   * 用户要做的是"把文件换小",不是"改一下参数"。
   */
  'PAYLOAD_TOO_LARGE',
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
  PAYLOAD_TOO_LARGE: 413,
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
  PAYLOAD_TOO_LARGE: '请求体过大,请缩小内容后重试',
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
