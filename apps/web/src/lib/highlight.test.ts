/**
 * 命中词高亮的纯逻辑测试(v2.14)。
 *
 * ⚠️ 这一组的**核心是一条性质**:把返回的片段首尾拼起来,必须**逐字等于原文**。
 * 高亮只是视觉加工,任何"少显示了几个字"的实现都是缺陷 —— 而且用户不会察觉,
 * 他只会觉得这段话读起来有点怪。
 */
import { describe, expect, it } from 'vitest';

import { escapeRegExp, splitByQuery } from './highlight';

/** 拼接回原文 —— 每个用例都过一遍这条不变量。 */
function rejoin(segments: readonly { text: string }[]): string {
  return segments.map((segment) => segment.text).join('');
}

describe('splitByQuery', () => {
  it('命中处被切出来并标记,其余保持未命中', () => {
    const segments = splitByQuery('接口规范 v2 修订', '规范');
    expect(segments).toEqual([
      { text: '接口', hit: false },
      { text: '规范', hit: true },
      { text: ' v2 修订', hit: false },
    ]);
  });

  it('多处命中都被切出来', () => {
    const segments = splitByQuery('aXbXc', 'X');
    expect(segments.filter((segment) => segment.hit)).toHaveLength(2);
    expect(rejoin(segments)).toBe('aXbXc');
  });

  it('★ 大小写不敏感(服务端是 ILIKE,前端区分大小写就会「搜到了但没高亮」)', () => {
    const segments = splitByQuery('ReadMe 与 readme', 'readme');
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual([
      'ReadMe',
      'readme',
    ]);
  });

  it('★★ 正则元字符当普通字符 —— 搜 a.b 不能把 aXb 也高亮', () => {
    const segments = splitByQuery('aXb a.b', 'a.b');
    const hits = segments.filter((segment) => segment.hit).map((segment) => segment.text);
    expect(hits).toEqual(['a.b']);
    expect(rejoin(segments)).toBe('aXb a.b');
  });

  it('★ 空查询 / 空白查询:整段原样返回,不切成碎片', () => {
    // 空查询若也走切分,会在每个字符之间插入空片段,
    // 而 <mark> 的边界会把文本拆得七零八落(视觉上就是字距变了)。
    expect(splitByQuery('任意内容', '')).toEqual([{ text: '任意内容', hit: false }]);
    expect(splitByQuery('任意内容', '   ')).toEqual([{ text: '任意内容', hit: false }]);
  });

  it('空文本返回一个空片段', () => {
    expect(splitByQuery('', 'x')).toEqual([{ text: '', hit: false }]);
  });

  it('没命中时整段原样返回', () => {
    expect(splitByQuery('接口规范', 'zzz')).toEqual([{ text: '接口规范', hit: false }]);
  });

  it('命中在开头 / 结尾时不会多出空片段', () => {
    expect(splitByQuery('规范修订', '规范')).toEqual([
      { text: '规范', hit: true },
      { text: '修订', hit: false },
    ]);
    expect(splitByQuery('修订规范', '规范')).toEqual([
      { text: '修订', hit: false },
      { text: '规范', hit: true },
    ]);
  });

  it('查询词含空格:只有两端被去掉,中间的空格算内容', () => {
    const segments = splitByQuery('后端 组规范', ' 组规范');
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual([
      '组规范',
    ]);
  });

  it('★★ 不变量:任何输入下,片段拼回来都逐字等于原文', () => {
    const cases: [string, string][] = [
      ['接口规范 v2 修订(技术部)', '规范'],
      ['a.b.c', '.'],
      ['汉字与English混排', 'english'],
      ['(((括号)))', '('],
      ['结尾命中规范', '规范'],
      ['规范开头命中', '规范'],
    ];
    for (const [text, query] of cases) {
      expect(rejoin(splitByQuery(text, query))).toBe(text);
    }
  });
});

describe('escapeRegExp', () => {
  it('转义所有正则元字符', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    const escaped = escapeRegExp(raw);
    // 转义之后当成正则源用,必须能匹配它自己的字面量
    expect(new RegExp(escaped).test(raw)).toBe(true);
  });

  it('普通文本不受影响', () => {
    expect(escapeRegExp('接口规范')).toBe('接口规范');
  });
});
