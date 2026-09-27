/**
 * 个人列表(最近浏览 / 收藏 / 检索历史)的纯逻辑测试(v2.14)。
 *
 * 这三种列表都有一个共同的失败方式:**错了不报错,只是列表看起来不太对**。
 * 比如出现重复项、或者第 N+1 条把最早那条悄悄挤掉。没人会为这种事提 bug,
 * 但它会持续消耗信任(「我明明看过那篇,怎么不在列表里」)。
 */
import { describe, expect, it } from 'vitest';

import {
  isRecentEntry,
  isString,
  parseStoredList,
  pushRecent,
  pushSearchTerm,
  toggleFavorite,
  type RecentEntry,
} from './personal-lists';

function entry(id: string, title: string, at: number): RecentEntry {
  return { id, title, at };
}

describe('pushRecent', () => {
  it('新条目插到最前面', () => {
    const list = pushRecent([entry('a', 'A', 1)], entry('b', 'B', 2));
    expect(list.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('已存在的条目置顶并更新时间,而不是留两条', () => {
    const list = pushRecent([entry('b', 'B', 2), entry('a', 'A', 1)], entry('a', 'A', 3));
    expect(list.map((item) => item.id)).toEqual(['a', 'b']);
    expect(list[0]?.at).toBe(3);
  });

  it('按 id 去重,不是按标题 —— 不同部门可以有同名文档', () => {
    // 按标题去重会把另一篇悄悄吃掉,而表现只是「我明明看过那篇,列表里却没有」。
    const list = pushRecent(
      [entry('dept-a-weekly', '周报', 1)],
      entry('dept-b-weekly', '周报', 2),
    );
    expect(list.map((item) => item.id)).toEqual(['dept-b-weekly', 'dept-a-weekly']);
  });

  it('超过上限时截断的是最早的那一条', () => {
    let list: RecentEntry[] = [];
    for (let index = 0; index < 5; index += 1) {
      list = pushRecent(list, entry('n' + String(index), 'T', index), 3);
    }
    expect(list.map((item) => item.id)).toEqual(['n4', 'n3', 'n2']);
  });

  it('不修改传入的数组(纯函数)', () => {
    const original = [entry('a', 'A', 1)];
    pushRecent(original, entry('b', 'B', 2));
    expect(original.map((item) => item.id)).toEqual(['a']);
  });
});

describe('toggleFavorite', () => {
  it('没有就加,加在最前面', () => {
    expect(toggleFavorite(['a'], 'b')).toEqual(['b', 'a']);
  });

  it('有就去掉(取消收藏)', () => {
    expect(toggleFavorite(['b', 'a'], 'b')).toEqual(['a']);
  });

  it('重复切换能回到原状(收藏是个开关)', () => {
    const once = toggleFavorite(['a'], 'b');
    expect(toggleFavorite(once, 'b')).toEqual(['a']);
  });
});

describe('pushSearchTerm —— 检索历史', () => {
  it('最近的排最前,重复词只留一条', () => {
    let list: string[] = [];
    list = pushSearchTerm(list, '接口');
    list = pushSearchTerm(list, '周报');
    list = pushSearchTerm(list, '接口');
    expect(list).toEqual(['接口', '周报']);
  });

  it('空词不进历史(回车一次空搜索会留下一条看不见的空行)', () => {
    expect(pushSearchTerm(['a'], '')).toEqual(['a']);
    expect(pushSearchTerm(['a'], '   ')).toEqual(['a']);
  });

  it('两头的空白会被去掉(否则「接口」与「接口 」会成为两条)', () => {
    expect(pushSearchTerm([], '  接口  ')).toEqual(['接口']);
  });

  it('超过上限时截断', () => {
    let list: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      list = pushSearchTerm(list, 'q' + String(index), 10);
    }
    expect(list).toHaveLength(10);
    expect(list[0]).toBe('q14');
  });
});

describe('parseStoredList —— 坏数据不能把页面弄崩', () => {
  it('合法 JSON 正常解析', () => {
    const list = parseStoredList(JSON.stringify(['a', 'b']), isString);
    expect(list).toEqual(['a', 'b']);
  });

  it('不是 JSON → 空列表,不抛异常', () => {
    // localStorage 里的东西是**用户能改的**(开发者工具、同步冲突、别的版本写入),
    // 抛异常的表现是整个首页白屏 —— 一个坏字符串不该让页面打不开。
    expect(parseStoredList('{oops', isString)).toEqual([]);
    expect(parseStoredList('null', isString)).toEqual([]);
    expect(parseStoredList('', isString)).toEqual([]);
  });

  it('数组里的坏条目被丢掉,好的留下', () => {
    const raw = JSON.stringify([
      { id: 'a', title: 'A', at: 1 },
      { id: 42 },
      null,
      { id: 'b', title: 'B', at: 2 },
    ]);
    const list = parseStoredList(raw, isRecentEntry);
    expect(list.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('JSON 是对象而不是数组 → 空列表', () => {
    expect(parseStoredList(JSON.stringify({ a: 1 }), isString)).toEqual([]);
  });
});
