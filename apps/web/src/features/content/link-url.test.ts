import { describe, expect, it } from 'vitest';

import { normalizeUrl } from './link-url';

/** 取归一化后的 href(断言里绝大多数用例都只关心这一个字段)。 */
function href(raw: string): string {
  const result = normalizeUrl(raw);
  if (!result.ok) throw new Error(`预期成功,实际被拒:${result.reason}`);
  return result.href;
}

describe('链接地址归一化', () => {
  it('只写了域名 → 补 https', () => {
    expect(href('example.com')).toBe('https://example.com');
    expect(href('example.com/a/b')).toBe('https://example.com/a/b');
    expect(href('  example.com  ')).toBe('https://example.com');
  });

  it('★ 补的是 https 而不是 http', () => {
    // 这条值得单独钉住:补 http 会让"看起来是安全的链接"降级成明文传输。
    expect(href('foo.internal')).toMatch(/^https:\/\//);
  });

  it('已经带协议的保持原样', () => {
    expect(href('https://example.com/x?a=1#h')).toBe('https://example.com/x?a=1#h');
    expect(href('http://example.com')).toBe('http://example.com');
  });

  it('★ mailto: / tel: 等协议不被补成 https', () => {
    // 补 https 会得到一个**打不开**的链接,而且用户看不出为什么。
    expect(href('mailto:hr@example.com')).toBe('mailto:hr@example.com');
    expect(href('tel:+8613800000000')).toBe('tel:+8613800000000');
    expect(href('ftp://files.example.com')).toBe('ftp://files.example.com');
  });

  it('★ 站内路径与页内锚点保持原样', () => {
    // 补 https 会把"跳到另一篇文档"悄悄改成"跳到外网站点 https:///n/xxx" ——
    // 不报错,但点开的是一片空白。
    expect(href('/n/4d1a-xxxx')).toBe('/n/4d1a-xxxx');
    expect(href('#第二节')).toBe('#第二节');
  });

  it('拒绝会执行脚本的协议', () => {
    const js = normalizeUrl('javascript:alert(1)');
    expect(js.ok).toBe(false);
    const data = normalizeUrl('data:text/html,<script>x</script>');
    expect(data.ok).toBe(false);
    // 大小写混写也要拦
    expect(normalizeUrl('JavaScript:alert(1)').ok).toBe(false);
  });

  it('空地址给出可读的理由(而不是静默写入空链接)', () => {
    const empty = normalizeUrl('   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain('链接地址');
  });

  it('中文路径不被百分号编码', () => {
    // 刻意不走 `new URL()`:它会把中文路径编码、把 `#` 之前规范化,
    // 于是用户回头看到的地址和他填的不一样。
    expect(href('example.com/文档/说明')).toBe('https://example.com/文档/说明');
  });
});
