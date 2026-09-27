/**
 * 正文相关的共享纯函数测试(v2.12)。
 *
 * 这些函数**前后端共用**,所以它们错了会同时错在两边 ——
 * 而"每页最多 10 张图"这条规则如果数错了,表现是
 * "明明只插了 3 张却说到顶了"或者反过来"插到 15 张也没人拦"。
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_DOC,
  MAX_IMAGES_PER_NODE,
  countImages,
  isExportFormat,
  isProseMirrorDoc,
} from '../src/content.js';
import type { ProseMirrorNode } from '../src/content.js';

const img = (): ProseMirrorNode => ({ type: 'image', attrs: { src: '/u/a.png' } });
const p = (text: string): ProseMirrorNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('countImages', () => {
  it('空文档 / null / undefined 都是 0', () => {
    expect(countImages(EMPTY_DOC)).toBe(0);
    expect(countImages(null)).toBe(0);
    expect(countImages(undefined)).toBe(0);
  });

  it('数顶层图片', () => {
    expect(countImages({ type: 'doc', content: [p('a'), img(), img()] })).toBe(2);
  });

  it('★ 递归整棵树 —— 嵌在表格单元格 / 引用块里的图片也要数到', () => {
    // 只数顶层是很容易犯的错:那样用户插到第 11 张才被拦,
    // 而提示里说的张数是错的(比实际少),会让人以为系统算错了。
    const nested: ProseMirrorNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', content: [p('x'), img()] }],
            },
          ],
        },
        { type: 'blockquote', content: [img()] },
        img(),
      ],
    };
    expect(countImages(nested)).toBe(3);
  });

  it('恰好到达上限时不算超(边界)', () => {
    const doc: ProseMirrorNode = {
      type: 'doc',
      content: Array.from({ length: MAX_IMAGES_PER_NODE }, img),
    };
    expect(countImages(doc)).toBe(MAX_IMAGES_PER_NODE);
    expect(countImages(doc) > MAX_IMAGES_PER_NODE).toBe(false);
  });

  it('上限是 10(用户指定的数字)', () => {
    expect(MAX_IMAGES_PER_NODE).toBe(10);
  });
});

describe('isExportFormat', () => {
  it('只认 md', () => {
    expect(isExportFormat('md')).toBe(true);
    expect(isExportFormat('pdf')).toBe(false);
    expect(isExportFormat('')).toBe(false);
    expect(isExportFormat(undefined)).toBe(false);
    expect(isExportFormat(1)).toBe(false);
  });
});

describe('isProseMirrorDoc', () => {
  it('根必须是 doc', () => {
    expect(isProseMirrorDoc({ type: 'doc', content: [] })).toBe(true);
    expect(isProseMirrorDoc({ type: 'paragraph' })).toBe(false);
    expect(isProseMirrorDoc(null)).toBe(false);
    expect(isProseMirrorDoc('doc')).toBe(false);
  });

  it('content 省略或为数组都接受,其它类型拒绝', () => {
    expect(isProseMirrorDoc({ type: 'doc' })).toBe(true);
    expect(isProseMirrorDoc({ type: 'doc', content: {} })).toBe(false);
  });
});
