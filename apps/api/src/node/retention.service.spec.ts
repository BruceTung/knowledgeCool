/**
 * 回收站保留策略的判定测试。
 *
 * 这里只测 `isPastRetention` 这一个纯函数,但它值得单独一个文件 ——
 * 这是整条自动清理链路上唯一"判断方向写反了也不会报错"的地方:
 * 把 `>=` 写成 `<`,后果是**下一次扫描把所有回收站内容清空**,
 * 而日志上只会显示"清理成功"。
 */
import { describe, expect, it } from 'vitest';

import { isPastRetention } from './retention.service.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 相对 NOW 往前 n 天。 */
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * MS_PER_DAY);
}

describe('isPastRetention', () => {
  it('还没到期的不过期(删了 29 天,保留 30 天)', () => {
    expect(isPastRetention(daysAgo(29), NOW, 30)).toBe(false);
  });

  it('刚好满 30 天算过期 —— 边界取闭区间', () => {
    expect(isPastRetention(daysAgo(30), NOW, 30)).toBe(true);
  });

  it('超过保留期(31 天)算过期', () => {
    expect(isPastRetention(daysAgo(31), NOW, 30)).toBe(true);
  });

  it('差 1 毫秒不算过期', () => {
    const almost = new Date(daysAgo(30).getTime() + 1);
    expect(isPastRetention(almost, NOW, 30)).toBe(false);
  });

  it('保留天数为 0 表示关闭 —— 任何东西都不过期', () => {
    expect(isPastRetention(daysAgo(3650), NOW, 0)).toBe(false);
  });

  it('保留天数为负数同样表示关闭', () => {
    expect(isPastRetention(daysAgo(3650), NOW, -1)).toBe(false);
  });

  it('从没被删过(deletedAt 为 null)永不过期', () => {
    expect(isPastRetention(null, NOW, 30)).toBe(false);
  });

  it('删除时间在未来(时钟回拨)不会被当成过期', () => {
    expect(isPastRetention(new Date(NOW.getTime() + MS_PER_DAY), NOW, 30)).toBe(false);
  });

  it('保留 1 天时按天判定', () => {
    expect(isPastRetention(daysAgo(0.9), NOW, 1)).toBe(false);
    expect(isPastRetention(daysAgo(1), NOW, 1)).toBe(true);
  });
});
