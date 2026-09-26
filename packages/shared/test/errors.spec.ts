/**
 * 错误码契约测试 —— DESIGN.md §6.1。
 * 前端只按一种形状解析错误,所以形状必须被测试锁死。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ERROR_MESSAGES,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  buildErrorBody,
  isErrorCode,
} from '../src/errors.js';

describe('错误码表', () => {
  it('恰好是 DESIGN.md §6.1 列出的 8 个', () => {
    expect([...ERROR_CODES]).toEqual([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'VALIDATION_FAILED',
      'VERSION_CONFLICT',
      'PASSWORD_CHANGE_REQUIRED',
      'RATE_LIMITED',
      'INTERNAL_ERROR',
    ]);
  });

  it('HTTP 状态码映射与文档一致', () => {
    expect(ERROR_HTTP_STATUS).toEqual({
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      VALIDATION_FAILED: 400,
      VERSION_CONFLICT: 409,
      PASSWORD_CHANGE_REQUIRED: 403,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
    });
  });

  it('每个错误码都有中文文案,且非空', () => {
    for (const code of ERROR_CODES) {
      expect(DEFAULT_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  /**
   * ⚠️ v2.0 起这条规则**反过来了**。
   *
   * 旧模型用 404 掩盖"存在但无权限",理由是防枚举。现在读对所有登录用户
   * 开放(§5.3 规则一),不存在"存在但读不到"的资源,所以没有需要掩盖的东西;
   * 写被拒时回 `FORBIDDEN` 是更有用的回应 —— 用户需要知道"东西在那儿,
   * 只是你不能改",而不是被误导成"它不存在"。
   */
  it('NOT_FOUND 不再掩盖「无权限」—— 文案只说内容不存在', () => {
    const message = DEFAULT_ERROR_MESSAGES.NOT_FOUND;
    expect(message).toContain('不存在');
    expect(message).not.toContain('权限');
  });

  /**
   * 这个码必须**独立存在**,不能并进通用 403 —— 前端要靠它跳转改密页。
   * 混进 FORBIDDEN 的话,用户只会看到一句"没有权限",然后卡死在原地。
   */
  it('PASSWORD_CHANGE_REQUIRED 是独立的码(前端据此跳转改密页)', () => {
    expect(ERROR_CODES).toContain('PASSWORD_CHANGE_REQUIRED');
    expect(DEFAULT_ERROR_MESSAGES.PASSWORD_CHANGE_REQUIRED).toContain('密码');
  });
});

describe('buildErrorBody', () => {
  it('产出 { error: { code, message } } 形状', () => {
    expect(buildErrorBody('FORBIDDEN')).toEqual({
      error: { code: 'FORBIDDEN', message: DEFAULT_ERROR_MESSAGES.FORBIDDEN },
    });
  });

  it('允许覆盖文案', () => {
    const body = buildErrorBody('FORBIDDEN', '你没有编辑该页面的权限');
    expect(body.error.message).toBe('你没有编辑该页面的权限');
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('details 缺省时不出现该键', () => {
    expect(buildErrorBody('NOT_FOUND')).not.toHaveProperty('error.details');
  });

  it('details 传入时原样带上', () => {
    const details = [{ field: 'title', message: '不能为空' }];
    expect(buildErrorBody('VALIDATION_FAILED', undefined, details).error.details).toEqual(details);
  });

  it('details 传 undefined 等同于不传', () => {
    expect(buildErrorBody('NOT_FOUND', undefined, undefined)).not.toHaveProperty('error.details');
  });

  it('每个错误码都能构造出合法响应体', () => {
    for (const code of ERROR_CODES) {
      const body = buildErrorBody(code);
      expect(isErrorCode(body.error.code)).toBe(true);
      expect(typeof body.error.message).toBe('string');
    }
  });
});

describe('isErrorCode', () => {
  it('接受合法错误码', () => {
    expect(isErrorCode('UNAUTHORIZED')).toBe(true);
  });

  it('拒绝未知值与非法类型', () => {
    expect(isErrorCode('unauthorized')).toBe(false);
    expect(isErrorCode('TEAPOT')).toBe(false);
    expect(isErrorCode(404)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });
});
