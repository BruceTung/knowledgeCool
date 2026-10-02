/**
 * 链接地址的归一化与校验(纯函数)。
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
 * 这里只做"该不该补协议 / 该不该拒绝"这两个判断,其余原样透传。
 *
 * ## ⚠️⚠️ v4.14:从**黑名单**改成**白名单**,并且必须与 Tiptap 的口径一致
 *
 * 原来只拦 `javascript:` / `data:` / `vbscript:` 三种,其余协议一律放行 ——
 * 于是 `file:` / `blob:` / `vscode:` / `chrome:` 等等都会"通过本函数",
 * 然后被 **Tiptap 的 Link 扩展**拒掉(它有自己的一份协议白名单)。
 *
 * 而 `setLink` 在协议不允许时是 **`return false`**:
 * ```js
 *   setLink: (attributes) => ({ chain }) => {
 *     if (!this.options.isAllowedUri(href, …)) return false;   // ← 静默返回
 * ```
 * 调用方(`LinkPopover.apply`)当时**没有看这个返回值**,于是:
 * 命令什么都没做,气泡却照常关闭 —— 用户以为链接加上了,**其实一个都没有**,
 * 而且**不给任何提示**。这是最坏的一种失败:不报错、不留痕。
 *
 * 修法是两条一起上:
 *   1. 本函数改成白名单,口径**直接对齐 Tiptap**(避免"我们放行、编辑器拒绝");
 *   2. 调用方检查 `run()` 的返回值,不成功就报错并**不关气泡**(兜底,
 *      管住将来任何我们没预料到的拒绝)。
 *
 * 白名单取自 `@tiptap/extension-link` 的 `isAllowedUri` 默认表
 * (`http / https / ftp / ftps / mailto / tel / callto / sms / cid / xmpp`)。
 * 刻意**照抄**而不是各写一份:两边不一致就会重新引入上面那个"静默失败"。
 */

/**
 * 允许的协议 —— **必须与 Tiptap 的默认白名单一致**。
 *
 * 见 `@tiptap/extension-link` 的 `isAllowedUri`:
 * `["http","https","ftp","ftps","mailto","tel","callto","sms","cid","xmpp"]`。
 */
const ALLOWED_SCHEMES = [
  'http',
  'https',
  'ftp',
  'ftps',
  'mailto',
  'tel',
  'callto',
  'sms',
  'cid',
  'xmpp',
] as const;

/** 带了协议前缀(`scheme:`)。只认"字母开头",与 URL 规范一致。 */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** 归一化的结果。`ok: false` 时 `reason` 是给用户看的一句话。 */
export type NormalizeUrlResult = { ok: true; href: string } | { ok: false; reason: string };

export function normalizeUrl(raw: string): NormalizeUrlResult {
  const trimmed = raw.trim();

  if (trimmed === '') return { ok: false, reason: '请填写链接地址' };

  /*
    ⚠️ 先判 `//`(协议相对地址),再判单斜杠。

    `//example.com` 看起来像站内路径,**其实是"跟着当前页面的协议走的外站地址"**。
    原来它落进"站内路径"那一支被原样保留,于是"看着像站内、点开是外站"。
    明确补成 https,语义就与它实际的行为一致了。
    (Tiptap 那边 `//` 开头也算合法 —— 它以 `/` 起头,命中 `[^a-z]`。)
  */
  if (trimmed.startsWith('//')) return { ok: true, href: `https:${trimmed}` };

  // 站内路径与页内锚点:原样保留
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return { ok: true, href: trimmed };

  const scheme = SCHEME.exec(trimmed)?.[1];
  if (scheme !== undefined) {
    if ((ALLOWED_SCHEMES as readonly string[]).includes(scheme.toLowerCase())) {
      return { ok: true, href: trimmed };
    }
    return {
      ok: false,
      reason: `不支持 ${scheme}: 开头的地址。可用的是 http / https / mailto / tel,或站内路径(/…)与锚点(#…)`,
    };
  }

  // 剩下的都当"只写了域名或路径",补 https
  return { ok: true, href: `https://${trimmed}` };
}
