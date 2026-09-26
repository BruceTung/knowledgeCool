/**
 * 检索的纯逻辑测试(DESIGN.md §8.3)。
 *
 * SQL 那一半(权限过滤、排序)由端到端验收覆盖 ——
 * 这里只测两件容易写错、且错了不会报错的事:
 * 关键词转义与片段生成。
 */
import { describe, expect, it } from 'vitest';

import { escapeLike, snippetOf } from './search.service.js';

describe('escapeLike', () => {
  it('⚠️ % 必须转义 —— 否则搜 "100%" 会命中全部内容', () => {
    expect(escapeLike('100%')).toBe('100\\%');
  });

  it('_ 必须转义 —— 否则它会被当成"任意一个字符"', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('反斜杠自身要转义,不然会把后面的字符吃掉', () => {
    expect(escapeLike('C:\\path')).toBe('C:\\\\path');
  });

  it('中文与普通字符原样保留', () => {
    expect(escapeLike('权限模型')).toBe('权限模型');
  });

  it('组合场景:先转义反斜杠再转义通配符,顺序不能反', () => {
    // 若先转 % 再转 \,会把刚加上的转义符又转一次,得到 100\\%
    expect(escapeLike('%\\%')).toBe('\\%\\\\\\%');
  });
});

describe('snippetOf', () => {
  const text = `${'前'.repeat(80)}知识库${'后'.repeat(80)}`;

  it('命中时以关键词为中心截取', () => {
    const snippet = snippetOf(text, '知识库');
    expect(snippet).toContain('知识库');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('未命中时退回开头一段,而不是返回空串', () => {
    const snippet = snippetOf(text, '不存在的词');
    expect(snippet).not.toBe('');
    expect(snippet.startsWith('前')).toBe(true);
  });

  it('空正文返回空串', () => {
    expect(snippetOf('', '知识')).toBe('');
  });

  it('大小写不敏感(英文关键词)', () => {
    const snippet = snippetOf('Hello KnowledgeCool World', 'knowledgecool');
    expect(snippet.toLowerCase()).toContain('knowledgecool');
  });
});
