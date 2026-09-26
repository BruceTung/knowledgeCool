/**
 * 字号刻度的**机器检查**(v2.6)。
 *
 * 用户两次说"字体太小",第二次的原因不是没改,而是**没有刻度** ——
 * 六个档位混用,改完还会再漂。
 *
 * 所以这一条不是"测试某个函数",而是**扫描源码**:任何越界字号直接让测试红。
 * 规则要被机器执行,否则下次还是靠自觉(以及用户的第三次反馈)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALLOWED_ARBITRARY_PX, MIN_FONT_PX } from './typography';

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
    // 刻度文件自己说的就是"允许哪个值",测试文件要刻意写出越界值 —— 都跳过。
    // (但**业务代码的注释不跳过**,见下方说明。)
    if (file.endsWith('typography.ts')) continue;
    if (/\.test\.tsx?$/.test(file)) continue;

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        /*
          ⚠️ **注释里也照查,扫描器不区分注释。**

          这意味着"原来的 9px 太小了"这类说明不能写出完整的类名 ——
          写成"9px"或描述即可。这个约束是**故意**的,也是划算的:

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
      `低于 ${String(MIN_FONT_PX)}px 的字在屏幕上读不出来。` +
        '内容用 14px(text-sm),标签用 12px(text-xs),徽章用 11px(text-[11px])。',
    ).toEqual([]);
  });

  it(`唯一允许的任意值字号是 ${ALLOWED_ARBITRARY_PX.join(' / ')}px`, () => {
    const allowed = ALLOWED_ARBITRARY_PX as readonly number[];
    const odd = scanArbitrary().filter((hit) => !allowed.includes(hit.px));
    expect(
      odd.map((hit) => `${hit.file}:${String(hit.line)} → ${hit.token}`),
      `任意值字号只允许 ${ALLOWED_ARBITRARY_PX.join(' / ')}px(徽章)。\n` +
        '别的尺寸请用 Tailwind 具名档:text-xs(12)/ text-sm(14)/ text-base(16)/ text-lg(18)…\n' +
        '原因:具名档有内在比例,随手写死的像素值没有 —— 那正是字号失控的机制。\n' +
        '**特别注意:刻度里刻意没有 13px 这一档**,别再加回来(见 lib/typography.ts 的说明)。',
    ).toEqual([]);
  });

  it('确实扫到了文件(防止路径写错导致"静默全绿")', () => {
    // 一条"扫描类"测试最坏的失败方式不是报错,而是**什么都没扫到**却显示通过。
    expect(collect(SRC).length).toBeGreaterThan(20);
    expect(scanArbitrary().length).toBeGreaterThan(0);
  });
});
