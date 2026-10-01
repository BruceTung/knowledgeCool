/**
 * 链接地址的归一化(纯函数,有单测)。
 *
 * ## 为什么要归一化
 *
 * 用户填的地址有三种常见形态,而它们的处理**完全不同**:
 *
 * | 用户填的 | 应该变成 | 为什么 |
 * |---|---|---|
 * | `example.com/a` | `https://example.com/a` | 只写域名是最常见的输入。**必须补协议**:补成 `http://` 会让浏览器把 `//example.com` 当成相对路径,补成别的协议更是灾难 |
 * | `https://…` / `http://…` | 原样 | 已经带协议,不要自作聪明改掉 |
 * | `mailto:a@b.com` / `tel:` | 原样 | 它们**就是**协议,补 `https://` 会得到一个打不开的链接 |
 * | `/n/<id>` / `#锚点` | 原样 | 站内相对路径与页内锚点。补协议会把"站内跳转"悄悄改成"跳到外网站点" |
 *
 * 最后一条是最容易做错、也最难发现的:随手补 `https://` 会让
 * 「指向另一篇文档的链接」变成「指向 `https:///n/xxx`」,而且**不报错**。
 *
 * ⚠️ 不做 `new URL()` 解析后再 `toString()` —— 它会把中文路径百分号编码、
 * 把 `#` 之前的部分规范化,用户回头看到的地址和他填的不一样。
 * 这里只做"该不该补协议"这一个判断,其余原样透传。
 */

/** 带了协议前缀(`scheme:`)。`javascript:` 也在其中 —— 它由下面单独拦掉。 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** 危险协议。链接是**用户自己填**的,但仍不该让一篇文档能种下 XSS。 */
const DANGEROUS_SCHEME = /^(javascript|data|vbscript):/i;

/** 归一化的结果。`ok: false` 时 `reason` 是给用户看的一句话。 */
export type NormalizeUrlResult = { ok: true; href: string } | { ok: false; reason: string };

export function normalizeUrl(raw: string): NormalizeUrlResult {
  const trimmed = raw.trim();

  if (trimmed === '') return { ok: false, reason: '请填写链接地址' };

  if (DANGEROUS_SCHEME.test(trimmed)) {
    // 这两个协议可以直接执行脚本。剪贴板里带进来的"链接"未必是链接。
    return { ok: false, reason: '不支持 javascript: / data: 开头的地址' };
  }

  if (HAS_SCHEME.test(trimmed)) return { ok: true, href: trimmed };

  // 站内路径与页内锚点:原样保留
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return { ok: true, href: trimmed };

  // 剩下的都当"只写了域名或路径",补 https
  return { ok: true, href: `https://${trimmed}` };
}
