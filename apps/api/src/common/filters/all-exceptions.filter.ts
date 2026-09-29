import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import {
  DEFAULT_ERROR_MESSAGES,
  ERROR_HTTP_STATUS,
  type ApiErrorBody,
  type ErrorCode,
  buildErrorBody,
} from '@knowledgecool/shared';
import type { Request, Response } from 'express';

import { AppError } from '../errors/app-error.js';

/**
 * HTTP 状态码 → 统一错误码。
 * 只列 DESIGN.md §6.1 定义过的;其余按 4xx/5xx 归类兜底。
 */
const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = Object.freeze({
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
});

/**
 * 统一异常过滤器 —— **唯一**的出错出口。
 *
 * 保证前端永远只需按 `{ error: { code, message } }` 一种形状解析(§6.1)。
 * 三条刻意设计:
 *   1. 未被识别的异常一律变成 INTERNAL_ERROR,响应体里**不带**任何内部细节,
 *      堆栈只进服务端日志。否则等于把内网拓扑和 SQL 透给调用方。
 *   2. 框架抛的 HttpException 使用默认中文文案,不透传 NestJS 的英文原文。
 *   3. 只有 VALIDATION_FAILED 会把细节放进 `details` —— 前端需要逐字段提示。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.toResponse(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${body.error.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ApiErrorBody } {
    // 1) 我们主动抛的业务错误:保留自定义文案与细节。
    if (exception instanceof AppError) {
      return {
        status: ERROR_HTTP_STATUS[exception.code],
        body: buildErrorBody(exception.code, exception.message, exception.details),
      };
    }

    // 2) 框架抛的 HTTP 异常:映射成统一错误码,文案用默认中文。
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');
      const details = code === 'VALIDATION_FAILED' ? extractValidationDetails(exception) : undefined;

      // ⚠️ 一律用 §6.1 的默认文案,**不透传** exception.message。
      //
      // 原写法是一个三段式:
      //     code === 'VALIDATION_FAILED' || code === 'INTERNAL_ERROR'
      //       ? DEFAULT_ERROR_MESSAGES[code] : DEFAULT_ERROR_MESSAGES[code]
      // 两个分支**一模一样** —— 条件与整个三元表达式都是死代码。
      // 它的注释写着「5xx 不泄露原文,其余用默认文案」,但"其余"那个分支
      // 用的也是默认文案,所以那个"泄露"从来没发生过;真正的问题是它让人
      // 以为这里有一处需要留意的分流,而实际上没有。
      //
      // 想要的行为(与类注释第 2 条一致):框架抛的 HttpException 一律
      // 替换成中文默认文案 —— Nest 的英文原文只进日志。
      return { status, body: buildErrorBody(code, DEFAULT_ERROR_MESSAGES[code], details) };
    }

    // 3) body-parser / raw-body 抛的解析错误。
    //    ⚠️ 它们**不是** HttpException 的子类,只带 `status` / `type` 属性。
    //    不显式认出来的话,「请求体超过上限」会变成 500 —— 而它明明是客户端的问题,
    //    500 会把排查方向引到服务端,浪费很久。
    const parserError = asParserError(exception);
    if (parserError !== null) {
      return {
        status: parserError.status,
        body: buildErrorBody(
          'VALIDATION_FAILED',
          parserError.type === 'entity.too.large'
            ? '请求体过大,请缩小内容后重试'
            : '请求体解析失败',
        ),
      };
    }

    // 4) 其它一切(含非 Error 的抛出物):内部错误,细节只进日志。
    return {
      status: ERROR_HTTP_STATUS.INTERNAL_ERROR,
      body: buildErrorBody('INTERNAL_ERROR'),
    };
  }
}

/**
 * 识别 body-parser 的错误形状。
 *
 * `type === 'entity.too.large'` 是 URL 编码/JSON 解析器超限时的固定标识;
 * 用属性判断而不是 `instanceof`,因为 body-parser 不导出这些类,
 * 而且它的实现细节跨版本会变 —— 但这两个属性的契约很稳。
 */
function asParserError(exception: unknown): { status: number; type: string } | null {
  if (typeof exception !== 'object' || exception === null) return null;

  const candidate = exception as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;

  return { status, type: typeof candidate.type === 'string' ? candidate.type : '' };
}

/**
 * 从 ValidationPipe 抛出的异常里取出逐字段错误。
 * class-validator 会把 message 塞成 string[](可能是嵌套数组),这里拍平。
 */
function extractValidationDetails(exception: HttpException): unknown {
  const payload = exception.getResponse();

  if (typeof payload === 'string') return undefined;

  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message;
    if (Array.isArray(message)) return message.flat(Infinity);
    if (typeof message === 'string') return [message];
  }

  return undefined;
}
