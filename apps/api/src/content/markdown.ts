/**
 * ProseMirror 文档树 → Markdown 导出器(页面导出,§6.2)。
 *
 * 为什么不用现成的库:导出格式要做**产品级决策**(代码块围栏用什么、
 * 表格要不要转 GFM、嵌套列表缩进几格),而这些决策写在一处比藏在依赖里好。
 * 更重要的是它必须是**纯函数**,这样导出结果可以用单测钉死 ——
 * 导出错了没人会立刻发现,但拿到错文件的人会。
 *
 * ⚠️ 这是**单向**导出。反向(导入 Markdown)不在阶段一范围:
 * 导入需要处理"Markdown 能表达但文档树不能"和反之的所有情形,
 * 是个无底洞,而且阶段一没有真实需求。
 */

import type { ProseMirrorMark, ProseMirrorNode } from '@knowledgecool/shared';

/** 列表嵌套时每层的缩进。两个空格是 GFM 的惯例。 */
const INDENT = '  ';

/** 行内标记的包裹符号。顺序影响嵌套结果,按「外层先处理」排。 */
const MARK_WRAPPERS: Readonly<Record<string, { open: string; close: string }>> = Object.freeze({
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  strike: { open: '~~', close: '~~' },
  underline: { open: '<u>', close: '</u>' },
  code: { open: '`', close: '`' },
});

export function toMarkdown(doc: ProseMirrorNode | null | undefined): string {
  if (doc === null || doc === undefined) return '';
  const body = (doc.content ?? []).map((node) => block(node, 0)).join('');
  // 折叠三个以上连续换行 —— 列表结束时会各留一次,不处理会出现大片空行
  return `${body.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ------------------------------------------------------------------
// 块级
// ------------------------------------------------------------------

function block(node: ProseMirrorNode, indent: number): string {
  const pad = INDENT.repeat(indent);

  switch (node.type) {
    case 'heading': {
      const level = clampLevel(node.attrs?.['level']);
      return `${pad}${'#'.repeat(level)} ${inline(node)}\n\n`;
    }

    case 'paragraph':
      return `${pad}${inline(node)}\n\n`;

    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((child) => block(child, 0))
        .join('')
        .trimEnd();
      return `${inner
        .split('\n')
        .map((line) => `${pad}> ${line}`.trimEnd())
        .join('\n')}\n\n`;
    }

    case 'codeBlock': {
      const language = typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : '';
      // 代码块内容**不做行内转义** —— 它是逐字的。这是最容易写错的一处。
      const code = rawText(node);
      return `${pad}\`\`\`${language}\n${code}\n${pad}\`\`\`\n\n`;
    }

    case 'horizontalRule':
      return `${pad}---\n\n`;

    case 'bulletList':
      return list(node, indent, () => '- ');

    case 'orderedList': {
      const start = typeof node.attrs?.['start'] === 'number' ? node.attrs['start'] : 1;
      return list(node, indent, (index) => `${start + index}. `);
    }

    case 'taskList':
      return list(node, indent, (index, item) => {
        const checked = item.attrs?.['checked'] === true;
        return `- [${checked ? 'x' : ' '}] `;
      });

    case 'table':
      return table(node, indent);

    case 'image':
      return `${pad}${imageMarkdown(node)}\n\n`;

    default:
      // 未知块:递归它的子节点,尽量别丢内容
      return (node.content ?? []).map((child) => block(child, indent)).join('');
  }
}

function list(
  node: ProseMirrorNode,
  indent: number,
  bullet: (index: number, item: ProseMirrorNode) => string,
): string {
  const items = node.content ?? [];
  const pad = INDENT.repeat(indent);
  const bodyIndent = INDENT.repeat(indent + 1);

  const lines = items.map((item, index) => {
    const marker = bullet(index, item);
    const raw = (item.content ?? [])
      .map((child) => block(child, indent + 1))
      .join('')
      .trimEnd();

    const parts = raw.split('\n');
    // ⚠️ block() 给**第一行**也加了块级缩进,但列表标记本身就提供缩进 ——
    // 不剥掉这一层,会渲染成 `-   甲`(标记 + 两格缩进)。
    // 后续行保留缩进:那正是嵌套层级与续行需要的。
    if (parts[0] !== undefined && parts[0].startsWith(bodyIndent)) {
      parts[0] = parts[0].slice(bodyIndent.length);
    }

    const [first = '', ...rest] = parts;
    return [`${pad}${marker}${first}`, ...rest].filter((line) => line !== '').join('\n');
  });

  return `${lines.join('\n')}\n\n`;
}

function table(node: ProseMirrorNode, indent: number): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return '';

  const pad = INDENT.repeat(indent);
  const cellsOf = (row: ProseMirrorNode): string[] =>
    (row.content ?? []).map((cell) => inline(cell).replace(/\|/g, '\\|').trim());

  const header = cellsOf(rows[0] as ProseMirrorNode);
  const body = rows.slice(1).map(cellsOf);
  const width = Math.max(header.length, ...body.map((row) => row.length), 1);

  const line = (cells: string[]): string =>
    `${pad}| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;

  const lines = [
    line(header),
    `${pad}| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ];
  return `${lines.join('\n')}\n\n`;
}

// ------------------------------------------------------------------
// 行内
// ------------------------------------------------------------------

function inline(node: ProseMirrorNode | undefined): string {
  if (node === undefined) return '';
  return (node.content ?? []).map(inlineNode).join('');
}

function inlineNode(node: ProseMirrorNode): string {
  if (typeof node.text === 'string') return applyMarks(escape(node.text), node.marks);

  switch (node.type) {
    case 'hardBreak':
      // 行尾两个空格才是 Markdown 的硬换行(反斜杠也行,但两个空格更通用)
      return '  \n';
    case 'image':
      return imageMarkdown(node);
    default:
      return inline(node);
  }
}

/**
 * 按标记包裹文本。
 *
 * ⚠️ 两侧有空白时不能直接包裹:`** bold **` 不是粗体,
 * Markdown 要求标记紧贴非空白字符。这里把空白挪到标记外面。
 */
function applyMarks(text: string, marks: readonly ProseMirrorMark[] | undefined): string {
  if (marks === undefined || marks.length === 0) return text;

  let result = text;
  for (const mark of marks) {
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.['href'] === 'string' ? mark.attrs['href'] : '';
      if (href === '') continue;
      result = `[${result}](${href})`;
      continue;
    }

    const wrapper = MARK_WRAPPERS[mark.type];
    if (wrapper === undefined) continue;
    result = wrap(result, wrapper.open, wrapper.close);
  }
  return result;
}

function wrap(text: string, open: string, close: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (match === null) return `${open}${text}${close}`;
  const [, lead = '', core = '', tail = ''] = match;
  return core === '' ? text : `${lead}${open}${core}${close}${tail}`;
}

function imageMarkdown(node: ProseMirrorNode): string {
  const src = typeof node.attrs?.['src'] === 'string' ? node.attrs['src'] : '';
  const alt = typeof node.attrs?.['alt'] === 'string' ? node.attrs['alt'] : '';
  return `![${alt}](${src})`;
}

/** 逐字取文本,不做任何转义 —— 代码块用。 */
function rawText(node: ProseMirrorNode): string {
  const out: string[] = [];
  const walk = (n: ProseMirrorNode): void => {
    if (typeof n.text === 'string') out.push(n.text);
    for (const child of n.content ?? []) walk(child);
  };
  walk(node);
  return out.join('');
}

/**
 * 转义 Markdown 元字符。
 *
 * 保守策略:只转最容易破坏结构的那些。把 `#`、`-` 一律转义会让
 * 「2026-09-26」这种正常文本变成「2026\-09\-26」,可读性反而变差。
 */
function escape(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function clampLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(value)));
}
