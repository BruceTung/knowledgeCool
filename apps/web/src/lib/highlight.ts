/**
 * 检索结果的命中词高亮(v2.14)。
 *
 * 纯函数:`splitByQuery(text, query)` 把一段文本切成「命中 / 未命中」两种片段,
 * 组件只负责把命中的片段包成 <mark>。拆开是为了能测 —— 这里的边界比看上去多。
 *
 * ## 几个必须处理的边界(都来自"看起来没问题但其实会出错")
 *
 * 1. **大小写不敏感**。服务端用的是 ILIKE,前端如果区分大小写,
 *    就会出现「搜到了但一个都没高亮」—— 用户以为搜错了。
 * 2. **中文没有词边界**,所以不能按 \b 切,只能按子串。
 * 3. **查询里的正则元字符要当普通字符**。用户搜 `a.b` 时,
 *    如果直接把它塞进 RegExp,`.` 会匹配任意字符 —— 高亮的位置全是错的。
 * 4. **空查询不切**,否则会在每个字符之间插入空片段,把文本拆得七零八落。
 * 5. **片段要能拼回原文**。这是最容易写错的一条:漏掉某一段,
 *    用户看到的正文就**少了几个字**,而他不会知道少了。
 */

export interface HighlightSegment {
  text: string;
  /** 是否命中 */
  hit: boolean;
}

/** 把正则元字符转义成普通字符。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按查询词切分文本。
 *
 * 返回的片段**首尾相接一定等于原文** —— 这条是硬要求:
 * 高亮的实现方式不该改变正文内容。
 */
export function splitByQuery(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim();
  if (trimmed === "" || text === "") return [{ text, hit: false }];

  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  // 用 matchAll 而不是 split:split 会丢掉"哪里命中了"这个信息,
  // 而且带捕获组时会把捕获内容也塞进结果里(经典陷阱)。
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: match[0], hit: true });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
