/**
 * Markdown 导出器测试(M6)。
 *
 * 导出错了**没人会立刻发现** —— 拿到错文件的人只会以为"导出就这样"。
 * 所以每个块级与行内类型都有一条用例。
 */
import { describe, expect, it } from 'vitest';

import type { ProseMirrorNode } from '@knowledgecool/shared';

import { toMarkdown } from './markdown.js';

function doc(...content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'doc', content };
}

function text(value: string, marks?: ProseMirrorNode['marks']): ProseMirrorNode {
  return { type: 'text', text: value, ...(marks === undefined ? {} : { marks }) };
}

function para(...content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'paragraph', content };
}

describe('toMarkdown · 行内', () => {
  it('粗体 / 斜体 / 删除线 / 行内代码', () => {
    const md = toMarkdown(
      doc(
        para(text('粗', [{ type: 'bold' }])),
        para(text('斜', [{ type: 'italic' }])),
        para(text('删', [{ type: 'strike' }])),
        para(text('码', [{ type: 'code' }])),
      ),
    );
    expect(md).toContain('**粗**');
    expect(md).toContain('*斜*');
    expect(md).toContain('~~删~~');
    expect(md).toContain('`码`');
  });

  it('链接转成 [文本](href)', () => {
    const md = toMarkdown(
      doc(para(text('文档', [{ type: 'link', attrs: { href: 'https://example.com' } }]))),
    );
    expect(md).toContain('[文档](https://example.com)');
  });

  it('⚠️ 两侧有空白时标记要贴住内容 —— `** 粗 **` 在 Markdown 里不是粗体', () => {
    // 前后各垫一段:否则首尾空白会被文档级的 trim 吃掉,就测不到 wrap 的行为了
    const md = toMarkdown(
      doc(
        para(text('前言')),
        para(text(' 前后有空格 ', [{ type: 'bold' }])),
        para(text('后语')),
      ),
    );
    expect(md).toContain(' **前后有空格** \n');
    expect(md).not.toContain('** 前后有空格 **');
  });

  it('硬换行导出为行尾两个空格', () => {
    const md = toMarkdown(doc(para(text('上行'), { type: 'hardBreak' }, text('下行'))));
    expect(md).toContain('上行  \n下行');
  });

  it('正文里的 Markdown 元字符被转义,不会意外改变结构', () => {
    const md = toMarkdown(doc(para(text('这里有 *星号* 和 _下划线_'))));
    expect(md).toContain('这里有 \\*星号\\* 和 \\_下划线\\_');
  });
});

describe('toMarkdown · 块级', () => {
  it('标题层级按 level 输出 #,并夹在 1..6 之间', () => {
    const md = toMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('二级')] },
        { type: 'heading', attrs: { level: 99 }, content: [text('越界')] },
      ),
    );
    expect(md).toContain('## 二级');
    expect(md).toContain('###### 越界');
  });

  it('无序与有序列表', () => {
    const md = toMarkdown(
      doc(
        { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('甲'))] }] },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            { type: 'listItem', content: [para(text('丙'))] },
            { type: 'listItem', content: [para(text('丁'))] },
          ],
        },
      ),
    );
    expect(md).toContain('- 甲');
    // 有序列表要尊重 start —— 从 3 开始的列表不能写成 1.
    expect(md).toContain('3. 丙');
    expect(md).toContain('4. 丁');
  });

  it('任务列表带勾选状态', () => {
    const md = toMarkdown(
      doc({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [para(text('已做'))] },
          { type: 'taskItem', attrs: { checked: false }, content: [para(text('未做'))] },
        ],
      }),
    );
    expect(md).toContain('- [x] 已做');
    expect(md).toContain('- [ ] 未做');
  });

  it('代码块围栏带语言,内容逐字不转义', () => {
    const md = toMarkdown(
      doc({
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [text('const a = { b: "*x*" };')],
      }),
    );
    expect(md).toContain('```ts');
    // 关键:代码块里的 * 绝不能被转义,否则代码就被改坏了
    expect(md).toContain('const a = { b: "*x*" };');
    expect(md).not.toContain('\\*x\\*');
  });

  it('引用块每行都带 >', () => {
    const md = toMarkdown(doc({ type: 'blockquote', content: [para(text('第一行')), para(text('第二行'))] }));
    expect(md).toContain('> 第一行');
    expect(md).toContain('> 第二行');
  });

  it('分割线', () => {
    expect(toMarkdown(doc({ type: 'horizontalRule' }))).toContain('---');
  });

  it('图片语法与 alt', () => {
    const md = toMarkdown(
      doc({ type: 'image', attrs: { src: '/uploads/x.png', alt: '架构图' } }),
    );
    expect(md).toContain('![架构图](/uploads/x.png)');
  });

  it('嵌套列表用缩进表达层级', () => {
    const md = toMarkdown(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              para(text('父项')),
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [para(text('子项'))] }],
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('- 父项');
    expect(md).toMatch(/\n {2}- 子项/);
  });
});

describe('toMarkdown · 表格', () => {
  it('转成 GFM 表格,首行作表头,列宽对齐', () => {
    const md = toMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para(text('角色'))] },
              { type: 'tableHeader', content: [para(text('权限'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [para(text('编辑者'))] },
              { type: 'tableCell', content: [para(text('可写'))] },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('| 角色 | 权限 |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 编辑者 | 可写 |');
  });

  it('单元格里的竖线被转义,不会把表格撑坏', () => {
    const md = toMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', content: [para(text('a|b'))] }],
          },
        ],
      }),
    );
    expect(md).toContain('a\\|b');
  });
});

describe('toMarkdown · 整体', () => {
  it('空文档导出为空串而不是 undefined', () => {
    expect(toMarkdown(null)).toBe('');
    expect(toMarkdown(doc()).trim()).toBe('');
  });

  it('不会留下三个以上连续空行', () => {
    const md = toMarkdown(doc(para(text('甲')), para(text('乙')), para(text('丙'))));
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('未知块级节点递归导出子节点,不静默丢内容', () => {
    const md = toMarkdown(doc({ type: 'futureBlock', content: [para(text('别丢了我'))] }));
    expect(md).toContain('别丢了我');
  });
});
