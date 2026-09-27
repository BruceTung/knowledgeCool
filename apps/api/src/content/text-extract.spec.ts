/**
 * 纯文本抽取器测试(DESIGN.md §10 硬约束 6)。
 *
 * 为什么这一层必须有测试:它决定的不是"好不好看",而是**检索能不能搜到**。
 * 抽错了不会报任何错,只会让某类内容永远搜不出来 ——
 * 那种问题要等到有人抱怨"我明明写了却搜不到"才会被发现。
 */
import { describe, expect, it } from 'vitest';

import type { ProseMirrorNode } from '@knowledgecool/shared';

import { TEXT_FOR_SEARCH_MAX_LENGTH, extractPlainText } from './text-extract.js';

function doc(...content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'doc', content: content.length === 0 ? [] : content };
}

function para(text: string): ProseMirrorNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function heading(level: number, text: string): ProseMirrorNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

describe('extractPlainText', () => {
  it('空文档 / null / undefined 都返回空串,不抛错', () => {
    expect(extractPlainText(doc())).toBe('');
    expect(extractPlainText(null)).toBe('');
    expect(extractPlainText(undefined)).toBe('');
  });

  it('段落之间必须有分隔 —— 否则跨段落会拼出假命中', () => {
    // 「第一段末尾」+「第二段开头」如果不分隔,会连成 "末尾第二段开头",
    // 于是搜 "末尾第二" 也能命中。这是最容易漏的一处。
    const text = extractPlainText(doc(para('第一段末尾'), para('第二段开头')));
    expect(text).toBe('第一段末尾 第二段开头');
    expect(text).not.toContain('末尾第二段');
  });

  it('标题与正文都进索引(否则搜标题只能靠 title 列)', () => {
    const text = extractPlainText(doc(heading(1, '部署手册'), para('内部网络自托管')));
    expect(text).toContain('部署手册');
    expect(text).toContain('内部网络自托管');
  });

  it('嵌套列表的内容一条都不丢', () => {
    const list: ProseMirrorNode = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para('一级项')] },
        {
          type: 'listItem',
          content: [
            para('二级项'),
            {
              type: 'bulletList',
              content: [{ type: 'listItem', content: [para('三级项')] }],
            },
          ],
        },
      ],
    };
    const text = extractPlainText(doc(list));
    expect(text).toContain('一级项');
    expect(text).toContain('二级项');
    expect(text).toContain('三级项');
  });

  it('代码块内容逐字保留(含符号与缩进信息)', () => {
    const text = extractPlainText(
      doc({ type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'SELECT * FROM pages;' }] }),
    );
    expect(text).toContain('SELECT * FROM pages;');
  });

  it('表格单元格之间要有分隔,否则两列的词会粘成一个', () => {
    const table: ProseMirrorNode = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [para('角色')] },
            { type: 'tableCell', content: [para('权限')] },
          ],
        },
      ],
    };
    const text = extractPlainText(doc(table));
    expect(text).toContain('角色');
    expect(text).toContain('权限');
    expect(text).not.toContain('角色权限');
  });

  it('图片的 alt / title 也进索引 —— 否则截图说明搜不到', () => {
    const text = extractPlainText(
      doc({ type: 'image', attrs: { src: '/uploads/a.png', alt: '架构图', title: '四层结构' } }),
    );
    expect(text).toContain('架构图');
    expect(text).toContain('四层结构');
  });

  it('未知节点类型不抛错,递归取子节点内容', () => {
    // 编辑器升级加了新节点时,后端不该因为"不认识"就存不进正文
    const text = extractPlainText(
      doc({ type: 'someFutureNode', content: [para('未来的内容')] }),
    );
    expect(text).toBe('未来的内容');
  });

  it('超长正文按上限截断', () => {
    const long = '字'.repeat(TEXT_FOR_SEARCH_MAX_LENGTH + 5000);
    const text = extractPlainText(doc(para(long)));
    expect(text.length).toBe(TEXT_FOR_SEARCH_MAX_LENGTH);
  });

  it('连续空白归一成一个空格(换行会让跨行短语搜不到)', () => {
    const text = extractPlainText(doc(para('前后    有     空格')));
    expect(text).toBe('前后 有 空格');
  });
});
