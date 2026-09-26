/**
 * 统一请求封装 —— DESIGN.md §7.1 要求「lib/api.ts 统一请求封装」。
 *
 * 这一层存在的意义:把 §6.1 的错误体契约收敛到**一个**地方解析。
 * 业务代码只 catch `ApiError`,永远不需要自己去看 HTTP 状态码或猜响应体形状。
 */
import { type ApiErrorBody, type ErrorCode, isErrorCode } from '@knowledgecool/shared';

/** API 前缀。开发期由 Vite 代理到 localhost:3000;生产由 Nginx 反代同源。 */
const API_BASE = '/api/v1';

/** 业务错误。前端只需分辨 code,不需要关心 HTTP 状态码。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.code = body.error.code;
    this.details = body.error.details;
  }
}

/**
 * 校验响应体是否是 §6.1 定义的统一错误形状。
 *
 * 必须容错:反向代理、网关或 CDN 出错时返回的可能是 HTML 或空体,
 * 此时不能因为「解析不了」就抛出一个看不出原因的异常。
 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;

  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;

  const { code, message } = error as { code?: unknown; message?: unknown };
  return isErrorCode(code) && typeof message === 'string';
}

/**
 * 发起请求并返回解析后的 JSON。
 *
 * `credentials: 'include'` 是必须的 —— 会话走 HttpOnly Cookie(§6.1),
 * 而前后端在开发期不同端口,不带这个字段浏览器不会带 Cookie。
 *
 * ⚠️ 展开顺序很重要:`...init` 必须在 `headers` **之前**。
 * 反过来写的话,`init.headers` 会把整个合并后的 headers 覆盖掉,
 * `Accept: application/json` 就悄悄丢了 —— 这是个不会报错、
 * 只在特定服务端才发作的坑。
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { Accept: 'application/json', ...init?.headers },
  });

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    if (isApiErrorBody(payload)) throw new ApiError(payload);
    // 兜底:形状不对时也要给出可读信息,而不是抛一个 undefined。
    throw new ApiError({
      error: {
        code: 'INTERNAL_ERROR',
        message: `请求失败(HTTP ${response.status})`,
      },
    });
  }

  return payload as T;
}

/**
 * 发送带 JSON 请求体的写操作。
 *
 * 写操作一律显式走这里,而不是让每个调用点自己拼 `method` / `headers` / `body` ——
 * 那样总有一天会漏掉 `Content-Type`,而 Express 收到没有该头的 body 时
 * 不会解析,`@Body()` 拿到的是 undefined,报错信息还很难懂。
 */
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  if (body === undefined) {
    return apiFetch<T>(path, { method });
  }
  return apiFetch<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
