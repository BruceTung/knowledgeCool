/**
 * 统一异常过滤器单测 —— 把 DESIGN.md §6.1 的错误契约钉死。
 *
 * 这个过滤器是**唯一**的出错出口,它一旦漏掉某种异常,
 * 前端就会收到一个形状不同的响应体,而这类 bug 在联调时才暴露、排查很绕。
 */
import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppError } from '../errors/app-error.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

/** 造一个最小的 ArgumentsHost,只为拿到 status()/json() 的调用结果。 */
function capture(exception: unknown): CapturedResponse {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };

  const response = {
    status(code: number) {
      captured.statusCode = code;
      return {
        json(body: unknown) {
          captured.body = body;
        },
      };
    },
  } as unknown as Response;

  const request = { method: 'GET', url: '/api/v1/pages/abc' } as unknown as Request;

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe('AllExceptionsFilter', () => {
  describe('业务错误(AppError)保留自定义文案', () => {
    it('FORBIDDEN → 403', () => {
      const result = capture(AppError.forbidden('你没有编辑该页面的权限'));

      expect(result.statusCode).toBe(403);
      expect(result.body).toEqual({
        error: { code: 'FORBIDDEN', message: '你没有编辑该页面的权限' },
      });
    });

    it('NOT_FOUND → 404', () => {
      expect(capture(AppError.notFound()).statusCode).toBe(404);
    });

    it('VERSION_CONFLICT → 409', () => {
      const result = capture(AppError.versionConflict());

      expect(result.statusCode).toBe(409);
      expect(result.body).toEqual({
        error: { code: 'VERSION_CONFLICT', message: '该页面已被他人修改,请刷新后重试' },
      });
    });

    it('UNAUTHORIZED → 401', () => {
      expect(capture(AppError.unauthorized()).statusCode).toBe(401);
    });

    it('VALIDATION_FAILED 会带上 details', () => {
      const result = capture(AppError.validation('标题不合法', [{ field: 'title' }]));

      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({
        error: {
          code: 'VALIDATION_FAILED',
          message: '标题不合法',
          details: [{ field: 'title' }],
        },
      });
    });
  });

  describe('框架异常(HttpException)收敛成默认中文文案', () => {
    it('NestJS 的英文原文不透传给前端', () => {
      const result = capture(new NotFoundException('Cannot GET /api/v1/pages/abc'));

      expect(result.statusCode).toBe(404);
      expect(result.body).toEqual({
        error: { code: 'NOT_FOUND', message: '页面不存在或你没有访问权限' },
      });
      // 关键断言:内部路由信息不能出现在响应体里
      expect(JSON.stringify(result.body)).not.toContain('Cannot GET');
    });

    it('ForbiddenException → FORBIDDEN', () => {
      const result = capture(new ForbiddenException());

      expect(result.statusCode).toBe(403);
      expect(result.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('ValidationPipe 的 string[] 会被拍平进 details', () => {
      const exception = new BadRequestException({
        statusCode: 400,
        message: ['title 不能为空', 'position 必须是数字'],
        error: 'Bad Request',
      });

      const result = capture(exception);

      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({
        error: {
          code: 'VALIDATION_FAILED',
          message: '请求参数不正确',
          details: ['title 不能为空', 'position 必须是数字'],
        },
      });
    });

    it('嵌套数组的校验错误也会被拍平', () => {
      const exception = new BadRequestException({
        message: [['a 不合法'], ['b 不合法']],
      });

      const result = capture(exception) as { body: { error: { details: unknown } } };
      expect(result.body.error.details).toEqual(['a 不合法', 'b 不合法']);
    });

    it('其它 4xx(如 405)归类为 VALIDATION_FAILED', () => {
      const exception = new BadRequestException();
      Object.defineProperty(exception, 'getStatus', { value: () => 405 });

      expect(capture(exception).statusCode).toBe(405);
    });
  });

  describe('未知异常一律 500,且不泄露内部细节', () => {
    it('普通 Error 变成 INTERNAL_ERROR', () => {
      const result = capture(new Error('数据库连接串 postgres://user:pw@10.0.0.5:5432 不可用'));

      expect(result.statusCode).toBe(500);
      expect(result.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
      });
    });

    it('错误细节绝不出现在响应体里', () => {
      const leaky = new Error('SELECT * FROM users WHERE password_hash = 死循环');
      const serialized = JSON.stringify(capture(leaky).body);

      expect(serialized).not.toContain('SELECT');
      expect(serialized).not.toContain('password_hash');
    });

    it('非 Error 的抛出物也能被接住', () => {
      const result = capture('随便扔了个字符串');

      expect(result.statusCode).toBe(500);
      expect(result.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
      });
    });

    it('抛 null 也不会让过滤器自身崩掉', () => {
      expect(() => capture(null)).not.toThrow();
      expect(capture(null).statusCode).toBe(500);
    });
  });
});
