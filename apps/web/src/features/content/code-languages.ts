/**
 * 代码块的语言清单 + 语法高亮注册表(v2.10)。
 *
 * ## 为什么把"清单"和"注册表"写在同一个文件里
 *
 * 这两件事必须**永远一致**:下拉里有 `kotlin`,但 lowlight 没注册它,
 * 结果是"选了语言但没有任何着色" —— **不报错,只是没效果**。
 * 这种不一致在界面上完全看不出来,所以不能靠人记住"改一处要同时改另一处"。
 *
 * 这里的做法:`CODE_LANGUAGES` 是唯一数据源,注册表由它**推导**出来
 * (`lowlightRegistry()`),再加一条单测断言每个 id 都真的注册过。
 *
 * ## 为什么只注册这些语言
 *
 * 每个 `highlight.js/lib/languages/*` 都是独立的语法文件,全量引入
 * (highlight.js 自带 190+) 会让这个页面的 JS 包大出几百 KB,而其中
 * 99% 的语言这家公司不会写。这里按"研发规范里真的会出现"挑了十几个。
 *
 * 语言名字用 highlight.js 的**规范名**(`javascript` 而不是 `js`),
 * 别名(`js` / `ts` / `sh` …)显式注册成指向同一个语法的键 ——
 * 这样从别处粘过来的 ` ```js ` 也照样能着色。
 */
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createLowlight } from 'lowlight';

import type { LanguageFn } from 'highlight.js';

/**
 * lowlight 没有导出实例的类型(它的 `index.d.ts` 里是个内联返回类型),
 * 所以从工厂函数的返回值推出来 —— 好过自己手抄一份结构。
 */
export type Lowlighter = ReturnType<typeof createLowlight>;

/** 一个可选的语言。`aliases` 也注册进 lowlight,保证粘进来的 ` ```js ` 能着色。 */
export interface CodeLanguage {
  /** highlight.js 的规范名,也是存进 `codeBlock.language` 的值。 */
  id: string;
  label: string;
  aliases: readonly string[];
  grammar: LanguageFn;
}

/**
 * 语言清单。**顺序就是下拉里的顺序** —— `plaintext` 固定在第一位,
 * 因为它是默认值,"不选语言"应该是最容易选到的那一项。
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: 'plaintext', label: '纯文本', aliases: [], grammar: plaintext },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx'], grammar: javascript },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx'], grammar: typescript },
  { id: 'json', label: 'JSON', aliases: [], grammar: json },
  { id: 'yaml', label: 'YAML', aliases: ['yml'], grammar: yaml },
  { id: 'bash', label: 'Shell / Bash', aliases: ['sh', 'shell', 'zsh', 'console'], grammar: bash },
  { id: 'python', label: 'Python', aliases: ['py'], grammar: python },
  { id: 'java', label: 'Java', aliases: [], grammar: java },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'], grammar: kotlin },
  { id: 'go', label: 'Go', aliases: ['golang'], grammar: go },
  { id: 'rust', label: 'Rust', aliases: ['rs'], grammar: rust },
  { id: 'c', label: 'C', aliases: [], grammar: c },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc'], grammar: cpp },
  { id: 'css', label: 'CSS', aliases: [], grammar: css },
  { id: 'xml', label: 'HTML / XML', aliases: ['html', 'htm', 'xhtml'], grammar: xml },
  { id: 'sql', label: 'SQL', aliases: ['mysql', 'postgres', 'postgresql'], grammar: sql },
  { id: 'markdown', label: 'Markdown', aliases: ['md'], grammar: markdown },
  { id: 'dockerfile', label: 'Dockerfile', aliases: ['docker'], grammar: dockerfile },
];

/** 默认语言(不指定时用它)。 */
export const DEFAULT_CODE_LANGUAGE = 'plaintext';

/**
 * 由 `CODE_LANGUAGES` **推导**出的注册表。
 * 不要让调用方手写一份 —— 两份清单一定会漂移,而且漂移时不报错。
 */
export function lowlightRegistry(): Record<string, LanguageFn> {
  const registry: Record<string, LanguageFn> = {};
  for (const language of CODE_LANGUAGES) {
    registry[language.id] = language.grammar;
    for (const alias of language.aliases) registry[alias] = language.grammar;
  }
  return registry;
}

/** 建一个已注册全部语言的高亮器。 */
export function createLowlighter(): Lowlighter {
  return createLowlight(lowlightRegistry());
}

/** 由 id / 别名找出清单项。找不到返回 undefined。 */
export function findLanguage(name: string | null | undefined): CodeLanguage | undefined {
  if (name === null || name === undefined || name === '') return undefined;
  const lower = name.toLowerCase();
  return CODE_LANGUAGES.find(
    (language) => language.id === lower || language.aliases.some((alias) => alias === lower),
  );
}

/**
 * 把任意语言字符串归一到清单里的 **id**。
 *
 * 用途:代码块里存的可能是 `js`(别处粘过来的),而下拉的值必须是 `javascript` ——
 * 否则下拉会显示成空(没有匹配的 option),用户以为语言丢了。
 * 认不出来的一律当纯文本。
 */
export function normalizeLanguage(name: string | null | undefined): string {
  return findLanguage(name)?.id ?? DEFAULT_CODE_LANGUAGE;
}

/** 语言在界面上的显示名。认不出来时回显原始值,而不是显示"未知"。 */
export function languageLabel(name: string | null | undefined): string {
  if (name === null || name === undefined || name === '') return '纯文本';
  return findLanguage(name)?.label ?? name;
}
