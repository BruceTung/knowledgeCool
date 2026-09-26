/**
 * ProseMirror 文档树 → 纯文本 抽取器(DESIGN.md §10 硬约束 6)。
 *
 * 为什么必须有这一层:`page_contents.content_json` 是 JSONB,
 * `ILIKE '%中文%'` 对它无效 —— JSONB 没法直接做子串匹配。
 * 而阶段二接上 Yjs 之后,正文会变成**二进制快照**,更没法搜。
 * 所以每次落库正文时同步拍一份纯文本到 `text_for_search`,检索只查这一列。
 *
 * 设计取舍:
 *  - **纯函数、零 IO**:抽取规则是"错了不会立刻报错"的那类逻辑,
 *    必须能被单测整体覆盖(§12 的测试优先级)。
 *  - **对未知节点宽容**:编辑器将来加了新节点类型,这里不认识就递归取子节点,
 *    而不是抛错 —— 否则一次前端升级就会让后端存不进正文。
 *  - **块与块之间插换行**:否则 "第一段末尾第二段开头" 会被连成一个词,
 *    搜 "末尾第二" 也会命中,产生假阳性。
 */

import type { ProseMirrorNode } from '@knowledgecool/shared';

/**
 * `text_for_search` 的长度上限。
 *
 * 不是数据库限制,是**检索质量与写入成本**的限制:
 * trgm 索引对超长文本的维护开销很大,而一段 20 万字之外的正文
 * 命中概率极低 —— 用户搜的永远是前面那些内容。
 */
export const TEXT_FOR_SEARCH_MAX_LENGTH = 100_000;

/** 需要在其前后断行的块级节点。 */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'bulletList',
  'orderedList',
  'taskList',
  'taskItem',
  'image',
]);

/** 抽取时可读化的节点类型 —— 这些节点的文本内容不在 `text` 里。 */
function altTextOf(node: ProseMirrorNode): string {
  if (node.type !== 'image') return '';
  const alt = node.attrs?.['alt'];
  const title = node.attrs?.['title'];
  const parts = [alt, title].filter((v): v is string => typeof v === 'string' && v !== '');
  return parts.join(' ');
}

/**
 * 抽取纯文本。
 *
 * @returns 归一化后的文本:块之间单换行、连续空白压成一个空格、首尾去空。
 */
export function extractPlainText(doc: ProseMirrorNode | null | undefined): string {
  if (doc === null || doc === undefined) return '';

  const out: string[] = [];
  walk(doc, out);

  return normalize(out.join(''));
}

function walk(node: ProseMirrorNode, out: string[]): void {
  // 原子节点(inline 的 image)自带文本
  if (typeof node.text === 'string') {
    out.push(node.text);
    return;
  }

  const alt = altTextOf(node);
  if (alt !== '') out.push(alt);

  const children = node.content;
  if (children === undefined || children.length === 0) {
    if (BLOCK_TYPES.has(node.type)) out.push('\n');
    return;
  }

  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    // 单元格之间用制表符,让 "A列值 B列值" 不会粘成一个词
    for (const child of children) walk(child, out);
    out.push('\t');
    return;
  }

  for (const child of children) walk(child, out);

  if (BLOCK_TYPES.has(node.type)) out.push('\n');
}

/**
 * 归一化。
 *
 * 连续空白(含换行)压成一个空格是**有意**的:检索是子串匹配,
 * 保留换行只会让跨行的短语搜不到(用户不可能在搜索框里按回车)。
 */
function normalize(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > TEXT_FOR_SEARCH_MAX_LENGTH
    ? collapsed.slice(0, TEXT_FOR_SEARCH_MAX_LENGTH)
    : collapsed;
}

/**
 * 生成检索结果里的片段。
 *
 * 刻意**不在服务端拼 `<em>` 标签**:那样等于把 HTML 生成放在后端,
 * 一旦忘了转义就是 XSS。这里只返回纯文本片段,高亮交给前端按索引切分。
 *
 * @param text  被搜索的纯文本
 * @param query 关键词
 * @param radius 关键词前后各保留多少个字符
 */
export function buildSnippet(text: string, query: string, radius = 60): string {
  if (text === '') return '';
  const q = query.trim();
  if (q === '') return text.slice(0, radius * 2);

  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text.slice(0, radius * 2);

  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + q.length + radius);

  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
