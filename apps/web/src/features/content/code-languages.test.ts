import { describe, expect, it } from 'vitest';

import {
  CODE_LANGUAGES,
  DEFAULT_CODE_LANGUAGE,
  createLowlighter,
  languageLabel,
  normalizeLanguage,
} from './code-languages';

describe('语言清单与高亮注册表', () => {
  it('★ 每个 id 与别名都真的注册进了 lowlight', () => {
    // 这条是这个文件存在的理由:清单里有、注册表里没有 => 选了语言却没着色,
    // 而且**不报任何错**。界面上完全看不出来,只有断言能拦住。
    const lowlight = createLowlighter();
    const missing: string[] = [];

    for (const language of CODE_LANGUAGES) {
      if (!lowlight.registered(language.id)) missing.push(language.id);
      for (const alias of language.aliases) {
        if (!lowlight.registered(alias)) missing.push(alias);
      }
    }

    expect(missing).toEqual([]);
  });

  it('id 唯一,且别名不会与别的 id / 别名撞车', () => {
    // 撞车会静默覆盖:两个语言抢同一个名字,后注册的赢 —— 于是"选了 A 显示 B 的语法"。
    const seen = new Map<string, string>();

    for (const language of CODE_LANGUAGES) {
      for (const name of [language.id, ...language.aliases]) {
        const owner = seen.get(name);
        expect(owner, `${name} 同时属于 ${String(owner)} 与 ${language.id}`).toBeUndefined();
        seen.set(name, language.id);
      }
    }
  });

  it('纯文本在第一位,且是默认值', () => {
    // 顺序就是下拉的顺序;"不选语言"应该是最容易选到的那一项。
    expect(CODE_LANGUAGES[0]?.id).toBe('plaintext');
    expect(DEFAULT_CODE_LANGUAGE).toBe('plaintext');
  });

  it('别名归一化到规范 id', () => {
    // 从别处粘过来的代码块常写 ```js / ```ts,下拉的值必须是规范名,
    // 否则 <select> 匹配不到 option,显示成空,用户以为语言丢了。
    expect(normalizeLanguage('js')).toBe('javascript');
    expect(normalizeLanguage('TS')).toBe('typescript');
    expect(normalizeLanguage('yml')).toBe('yaml');
    expect(normalizeLanguage('sh')).toBe('bash');
  });

  it('认不出来的语言当纯文本(而不是抛错或留空)', () => {
    expect(normalizeLanguage('brainfuck')).toBe('plaintext');
    expect(normalizeLanguage('')).toBe('plaintext');
    expect(normalizeLanguage(null)).toBe('plaintext');
    expect(normalizeLanguage(undefined)).toBe('plaintext');
  });

  it('显示名:认不出来时回显原始值,不显示"未知"', () => {
    // 显示"未知"会让用户以为自己写的 `brainfuck` 被系统改掉了;
    // 原样回显至少说明"我们保留了你写的东西,只是没给它着色"。
    expect(languageLabel('js')).toBe('JavaScript');
    expect(languageLabel('brainfuck')).toBe('brainfuck');
    expect(languageLabel('')).toBe('纯文本');
  });

  it('真的能产出高亮标记(不是只注册了名字)', () => {
    const lowlight = createLowlighter();
    const tree = lowlight.highlight('javascript', 'const a = 1;');

    // 遍历 hast,收集所有 class
    const classes: string[] = [];
    const walk = (node: { properties?: Record<string, unknown>; children?: unknown[] }): void => {
      const className = node.properties?.['className'];
      if (Array.isArray(className)) classes.push(...(className as string[]));
      for (const child of node.children ?? []) walk(child as never);
    };
    walk(tree);

    expect(classes.some((name) => name.startsWith('hljs-'))).toBe(true);
  });

  it('★ lowlight 对未注册的语言会抛错 —— 所以原始语言不能直接交给它', () => {
    // 这条是实测发现的,不是推测:lowlight **不会**对未知语言"原样返回不报错",
    // 它抛 `Unknown language: xxx is not registered`。
    // 一篇从别处粘进来的文档里只要有 ` ```brainfuck `,渲染就会炸。
    // (官方 tiptap 扩展对这个做了兜底:不在白名单里就退回 highlightAuto;
    //  但"界面上一律先过 normalizeLanguage"仍是我们要守的约定 —— 见下一条。)
    const lowlight = createLowlighter();
    expect(() => lowlight.highlight('brainfuck', '+++')).toThrow(/Unknown language/);
  });

  it('★ 经 normalizeLanguage 之后,任何输入都不会抛', () => {
    const lowlight = createLowlighter();
    for (const raw of ['brainfuck', 'js', '', '👀', 'a'.repeat(200)]) {
      expect(() => lowlight.highlight(normalizeLanguage(raw), '+++')).not.toThrow();
    }
  });
});
