/**
 * 请求封装的单元测试。
 *
 * 这里刻意不测 React 组件 —— 那需要 jsdom 与组件测试库,M1 还不需要。
 * 但**错误体解析**必须有测试:它是所有业务代码的公共依赖,
 * 一旦解析错,表现是「满屏莫名其妙的报错」,排查成本极高。
 */
import { describe, expect, it } from 'vitest';

import { ApiError, isApiErrorBody } from './api';

describe('isApiErrorBody', () => {
  it('接受合法错误体', () => {
    expect(
      isApiErrorBody({ error: { code: 'FORBIDDEN', message: '你没有编辑该页面的权限' } }),
    ).toBe(true);
  });

  it('接受带 details 的错误体', () => {
    expect(
      isApiErrorBody({
        error: { code: 'VALIDATION_FAILED', message: '参数不正确', details: ['title 不能为空'] },
      }),
    ).toBe(true);
  });

  it('拒绝未知错误码', () => {
    expect(isApiErrorBody({ error: { code: 'TEAPOT', message: 'x' } })).toBe(false);
  });

  it('拒绝缺字段或类型不对的响应', () => {
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody(undefined)).toBe(false);
    expect(isApiErrorBody('<!doctype html>')).toBe(false);
    expect(isApiErrorBody({})).toBe(false);
    expect(isApiErrorBody({ error: null })).toBe(false);
    expect(isApiErrorBody({ error: { code: 'NOT_FOUND' } })).toBe(false);
    expect(isApiErrorBody({ error: { code: 'NOT_FOUND', message: 123 } })).toBe(false);
  });
});

describe('ApiError', () => {
  it('把错误体摊平成 Error 的 message 与 code', () => {
    const error = new ApiError({
      error: { code: 'VERSION_CONFLICT', message: '该页面已被他人修改,请刷新后重试' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.message).toBe('该页面已被他人修改,请刷新后重试');
    expect(error.details).toBeUndefined();
  });

  it('保留 details', () => {
    const details = [{ field: 'title' }];
    const error = new ApiError({
      error: { code: 'VALIDATION_FAILED', message: '参数不正确', details },
    });

    expect(error.details).toEqual(details);
  });
});
