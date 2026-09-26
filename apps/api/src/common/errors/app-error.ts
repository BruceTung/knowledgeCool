import { DEFAULT_ERROR_MESSAGES, type ErrorCode } from '@knowledgecool/shared';

/**
 * 业务异常。
 *
 * 与 NestJS 自带 HttpException 的分工:
 *   - **AppError** = 我们自己主动抛的、语义明确的业务错误(带统一错误码 + 可定制中文文案)。
 *   - **HttpException** = 框架抛的(路由 404、ValidationPipe 400 等),
 *     由 AllExceptionsFilter 统一收敛成默认文案,避免把英文内部信息透给前端。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  // ---- 便捷构造:把 §6.1 的语义固化下来,避免各处手写错误码字符串 ----

  static unauthorized(message?: string): AppError {
    return new AppError('UNAUTHORIZED', message);
  }

  static forbidden(message?: string): AppError {
    return new AppError('FORBIDDEN', message);
  }

  /**
   * 「不存在」与「无权访问」刻意合并成同一个错误(§6.1)。
   * 用一个名字把这个决定钉在代码里,防止有人日后「顺手」把它拆开。
   */
  static notFound(message?: string): AppError {
    return new AppError('NOT_FOUND', message);
  }

  static validation(message?: string, details?: unknown): AppError {
    return new AppError('VALIDATION_FAILED', message, details);
  }

  static versionConflict(message?: string): AppError {
    return new AppError('VERSION_CONFLICT', message);
  }
}
