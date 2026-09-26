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

/**
 * 上传文件(multipart)。
 *
 * **不要**复用 `apiSend`:multipart 的 `Content-Type` 必须由浏览器自己填 ——
 * 因为 boundary 是浏览器生成的,手写 `Content-Type` 会让后端解析不出文件。
 * 这个坑的表现是"接口 400 或者 `file` 为 undefined",而 curl 手测却正常。
 */
export async function apiUpload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file);

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    body: form,
  });

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    if (isApiErrorBody(payload)) throw new ApiError(payload);
    throw new ApiError({
      error: { code: 'INTERNAL_ERROR', message: `上传失败(HTTP ${response.status})` },
    });
  }

  return payload as T;
}

/**
 * 触发一次浏览器下载。
 *
 * 导出接口返回的是 `text/markdown` 而不是 JSON,所以不能走 `apiFetch`
 * (它会尝试 `response.json()`)。这里直接拿 blob 造一个临时 `<a>` ——
 * 这样 Cookie 会照常带上,权限校验仍然生效。
 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    if (isApiErrorBody(payload)) throw new ApiError(payload);
    throw new ApiError({
      error: { code: 'INTERNAL_ERROR', message: `导出失败(HTTP ${response.status})` },
    });
  }

  // 文件名从 Content-Disposition 里取,取不到就用兜底名
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const utf8Name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const name = utf8Name === undefined ? fallbackName : decodeURIComponent(utf8Name);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让下载中途失败(部分浏览器),延迟释放更稳
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
