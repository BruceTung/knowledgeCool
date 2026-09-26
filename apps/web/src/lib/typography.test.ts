/**
 * 字号刻度的**机器检查**(v2.8)。
 *
 * 用户三次说字体太小,前两次我都在拍脑袋调数值。这次先查了 Atlassian Design System
 * 与 Ant Design 的公开规范,再定刻度(`lib/typography.ts` 里记了出处)。
 *
 * 这一条负责让刻度**不靠自觉**:扫描源码,任何越界字号直接让测试红。
 *
 * 两条断言:
 *   1. 没有任何字号小于 12px(Atlassian 的最小字号就是 12 —— 他们把 11 提上去的)
 *   2. 不允许任何任意值字号(`text-[13px]` 之类)
 *
 * 第 2 条比上一轮更严:上一轮还允许一个 11px 的例外,那一档已经被规范否掉了,
 * 所以现在**一个例外都没有**。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIN_FONT_PX } from './typography';

const SRC = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 递归收集所有 .ts / .tsx。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      collect(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  token: string;
  px: number;
}

/** 找出所有 `text-[Npx]` 形式的字号声明。 */
function scanArbitrary(): Hit[] {
  const hits: Hit[] = [];

  for (const file of collect(SRC)) {
    // 刻度文件自己说的就是"允许哪些值",测试文件要刻意写出越界值 —— 都跳过。
    // (业务代码的**注释不跳过**,见下方说明。)
    if (file.endsWith('typography.ts')) continue;
    if (/\.test\.tsx?$/.test(file)) continue;

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        /*
          ⚠️ **注释里也照查,扫描器不区分注释。**

          这意味着"原来 9px 太小了"这类说明不能写出完整的类名 ——
          写成"9px"或描述即可。这个约束是**故意**的:

            · 好处:规则没有任何绕过的余地(注释掉一行照样被查到)
            · 代价:写注释时换一种说法

          反过来做(先剥注释再扫)要靠正则认注释,而 `//` 出现在字符串里
          (比如 URL)就会误剥,反而更容易漏掉真实代码。
        */
        for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
          hits.push({
            file: relative(SRC, file).replace(/\\/g, '/'),
            line: index + 1,
            token: match[0],
            px: Number(match[1]),
          });
        }
      });
  }

  return hits;
}

describe('界面字号刻度', () => {
  it(`★ 没有任何字号小于 ${String(MIN_FONT_PX)}px`, () => {
    const tiny = scanArbitrary().filter((hit) => hit.px < MIN_FONT_PX);
    expect(
      tiny.map((hit) => `${hit.file}:${String(hit.line)} → ${hit.token}`),
      `低于 ${String(MIN_FONT_PX)}px 的字读不出来。Atlassian 的最小字号就是 12px` +
        '(他们的视觉改版特意把 11 提到 12),Ant Design 的辅助文字也是 12px。',
    ).toEqual([]);
  });

  it('★ 不允许任何任意值字号(四档全部走 Tailwind 具名档)', () => {
    const odd = scanArbitrary();
    expect(
      odd.map((hit) => `${hit.file}:${String(hit.line)} → ${hit.token}`),
      '四档刻度与 Tailwind 具名档一一对应:text-xs(12/16)、text-sm(14/20)、\n' +
        '以及 styles.css 里 .kc-prose 的 16px。这恰好与 Atlassian 的\n' +
        'font.body.small(12/16)、font.body(14/20)、font.body.large(16/24) 数值一致。\n' +
        '任意值一旦允许,9 / 10 / 11 / 12 / 13 并存的老问题就会回来 —— 那是用户\n' +
        '反馈三次的根源。别开这个口子。',
    ).toEqual([]);
  });

  it('确实扫到了文件(防止路径写错导致"静默全绿")', () => {
    // 一条"扫描类"测试最坏的失败方式不是报错,而是**什么都没扫到**却显示通过。
    expect(collect(SRC).length).toBeGreaterThan(20);
  });
});
