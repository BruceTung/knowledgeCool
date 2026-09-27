#!/usr/bin/env node
/**
 * 从**代码**生成文档里的事实性表格(接口 / 数据模型 / 环境变量 / 前端路由 / 脚本)。
 *
 * ## 为什么要有这个脚本
 *
 * 旧文档烂掉的根因不是"写得不用心",而是**它的事实来自记忆**:
 * 接口表、字段表、环境变量表都是手抄的,抄完没有任何东西会发现它与代码不符。
 * 于是漂移一直积累,直到有人(或某次真跑)撞上。
 *
 * 这里换一种做法:**事实由代码生成**。文档只保留手写的判断与理由,
 * 而"有哪些接口""有哪些字段""读哪些环境变量"一律由这个脚本回答。
 *
 * `pnpm audit:docs` 会重新生成并与文档比对 —— 一旦不一致就失败。
 * 即:**文档与代码脱节会让门禁变红,而不是靠人去发现。**
 *
 * 用法:
 *   node scripts/gen-doc.mjs          # 写回文档
 *   node scripts/gen-doc.mjs --check  # 只校验(audit:docs 用)
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'DESIGN.md';

/** 生成块标记:脚本只改这两个标记之间的内容,其余一个字都不碰。 */
function beginMarker(name) {
  return '<!-- BEGIN GENERATED:' + name + ' -->';
}
function endMarker(name) {
  return '<!-- END GENERATED:' + name + ' -->';
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function findFiles(dir, suffix, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated' || entry.name === 'dist') continue;
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) findFiles(rel, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(rel);
  }
  return out;
}

// ============================================================
// 1) 接口:从 @Controller 前缀 + @Get/@Post/... 提取
// ============================================================

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

/**
 * 取装饰器**自己那对括号内**的第一个字符串字面量(找不到返回空串)。
 *
 * ⚠️ 必须在**第一个 ) 处停住**。第一版只截了 200 个字符,于是 `@Get()`
 * (无参数)会一路扫到下面几行的 `@Query('cursor')`,把 `cursor` 当成路径 ——
 * 生成出 `GET /audit-logs/cursor` 这条**根本不存在的接口**,同时漏掉真正的 `GET /audit-logs`。
 * 这类"生成器自己编了一条接口"的错误,比文档漏写一条更危险:
 * 它会被当作事实写进文档,而文档的全部价值就在于它是真的。
 *
 * 不用正则,免得转义把脚本自己弄坏。
 */
function firstStringArg(text) {
  const open = text.indexOf('(');
  if (open < 0) return '';
  const parenEnd = text.indexOf(')', open + 1);
  const rest = text.slice(open + 1, parenEnd < 0 ? text.length : parenEnd);
  let quote = -1;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === SQ || rest[i] === DQ) { quote = i; break; }
  }
  if (quote < 0) return '';
  const ch = rest[quote];
  const close = rest.indexOf(ch, quote + 1);
  return close < 0 ? '' : rest.slice(quote + 1, close);
}

function extractRoutes() {
  const rows = [];
  for (const rel of findFiles('apps/api/src', '.controller.ts')) {
    const src = read(rel);
    const at = src.indexOf('@Controller');
    if (at < 0) continue;
    const prefix = firstStringArg(src.slice(at, at + 120));
    for (const method of HTTP_METHODS) {
      const needle = '@' + method;
      let from = 0;
      for (;;) {
        const i = src.indexOf(needle, from);
        if (i < 0) break;
        from = i + needle.length;
        const after = src.slice(i + needle.length, i + needle.length + 200);
        if (after[0] !== '(') continue;
        const sub = firstStringArg(after);
        const full = ('/' + [prefix, sub].filter((s) => s !== '').join('/'));
        rows.push({ method: method.toUpperCase(), path: full, file: rel });
      }
    }
  }
  return rows.sort((a, b) => ((a.path + a.method) < (b.path + b.method) ? -1 : 1));
}

function renderRoutes() {
  const rows = extractRoutes();
  const out = ['| 方法 | 路径 | 实现 |', '|---|---|---|'];
  for (const r of rows) {
    out.push('| ' + r.method + ' | ' + '`' + r.path + '`' + ' | ' + '`' + r.file.replace('apps/api/src/', '') + '`' + ' |');
  }
  out.push('');
  out.push('共 **' + String(rows.length) + '** 条。前缀 `/api/v1` 由 `app-setup.ts` 统一加;本表由 `scripts/gen-doc.mjs` 从控制器生成,`pnpm audit:docs` 会校验它是否与代码一致。');
  return out.join('\n');
}

// ============================================================
// 2) 数据模型:从 schema.prisma 提取 model / @@map / 字段
// ============================================================

function extractModels() {
  const src = read('apps/api/prisma/schema.prisma');
  const out = [];
  let cursor = 0;
  for (;;) {
    const at = src.indexOf('model ', cursor);
    if (at < 0) break;
    const braceOpen = src.indexOf('{', at);
    // ⚠️ 闭合大括号必须找**行首**的那个(模型正文里可能有 `}`)。
    // 第一版用 indexOf('}'),于是 `detail Json @default("{}")` 里的 `{}`
    // 把正文截断了 —— AuditLog 只剩 6 个字段(实际 9 个)、@@map 也丢了,
    // 生成出**错误的事实**。这正是这个脚本要消灭的那类问题,不能自己再犯。
    let braceClose = -1;
    for (let scan = braceOpen + 1; scan < src.length; scan += 1) {
      if (src[scan] !== '}') continue;
      // 行首(允许前面只有空白)
      let back = scan - 1;
      while (back > braceOpen && (src[back] === ' ' || src[back] === String.fromCharCode(9))) back -= 1;
      if (src[back] === String.fromCharCode(10)) { braceClose = scan; break; }
    }
    if (braceOpen < 0 || braceClose < 0) break;
    cursor = braceClose + 1;
    const name = src.slice(at + 6, braceOpen).trim();
    const body = src.slice(braceOpen + 1, braceClose);
    const mapAt = body.indexOf('@@map(');
    const mapName = mapAt < 0 ? '' : firstStringArg(body.slice(mapAt));
    const fields = [];
    for (const raw of body.split(String.fromCharCode(10))) {
      const line = raw.trim();
      if (line === '' || line.startsWith('//') || line.startsWith('@@')) continue;
      const parts = line.split(' ').filter((x) => x !== '');
      if (parts.length < 2) continue;
      fields.push({ name: parts[0], type: parts[1] });
    }
    out.push({ name, table: mapName === '' ? name : mapName, fields });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function renderModels() {
  const models = extractModels();
  const out = [];
  for (const m of models) {
    out.push('##### ' + m.name + '  →  ' + '`' + m.table + '`');
    out.push('');
    out.push('| 字段 | 类型 |');
    out.push('|---|---|');
    for (const f of m.fields) out.push('| ' + '`' + f.name + '`' + ' | ' + '`' + f.type + '`' + ' |');
    out.push('');
  }
  out.push('共 **' + String(models.length) + '** 张表。由 `scripts/gen-doc.mjs` 从 `schema.prisma` 生成,`pnpm audit:docs` 校验一致性。');
  return out.join('\n');
}

// ============================================================
// 3) 环境变量:从 configuration.ts 提取(key + 默认值)
// ============================================================

/*
  只认 `process.env.X` 出现在赋值右侧的行,并把该行整段作为"默认值表达式"。
  这么做而不是跑正则抠参数,是因为默认值里有 `24 * 30`、`isProduction` 这类表达式,
  抠参数会丢信息 —— 而文档里"默认 30 天"这种数字正是最容易被抄错的地方。
*/
function extractEnv() {
  const src = read('apps/api/src/config/configuration.ts');
  const all = src.split(String.fromCharCode(10));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i].trim();
    const at = line.indexOf('process.env.');
    if (at < 0) continue;
    let end = at + 12;
    while (end < line.length && /[A-Z0-9_]/.test(line[end])) end += 1;
    const key = line.slice(at + 12, end);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const colon = line.indexOf(':');
    let expr = colon < 0 ? '' : line.slice(colon + 1);
    expr = expr.replace(/,$/, '').trim();
    // ⚠️ 取不到就**明说取不到**,不要把上一行的标签之类填进来。
    // 第一版在这种情况下回退去读上一行,于是 DATABASE_URL 显示成 `databaseUrl:`、
    // NODE_ENV 显示成 `export function loadConfiguration...` ——
    // 那是"生成器编了一个看起来像值的东西",正是这份文档要消灭的问题。
    // 跨行赋值是少数情况,宁可让读者去看源码,也不要给一个错的值。
    out.push({ key, expr: expr === '' ? '跨行赋值,见 configuration.ts' : expr });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function renderEnv() {
  const rows = extractEnv();
  const out = [
    '| 环境变量 | 默认值 / 取值 |',
    '|---|---|',
  ];
  for (const r of rows) {
    out.push('| ' + '`' + r.key + '`' + ' | ' + '`' + r.expr.split('|').join('\\|') + '`' + ' |');
  }
  out.push('');
  out.push('共 **' + String(rows.length) + '** 个。由 `scripts/gen-doc.mjs` 从 `configuration.ts` 生成;与 `.env.example` 的双向比对由 `pnpm audit:docs` 负责。');
  return out.join('\n');
}

// ============================================================
// 4) 前端路由:从 App.tsx 提取
// ============================================================

function extractPages() {
  const src = read('apps/web/src/App.tsx');
  const out = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf('<Route path=', from);
    if (i < 0) break;
    from = i + 12; // 指向开引号本身(<Route path= 是 12 个字符)
    const rest = src.slice(from);
    const q = rest.indexOf(String.fromCharCode(34));
    if (q < 0) break;
    const closeQ = rest.indexOf(String.fromCharCode(34), q + 1);
    if (closeQ < 0) break;
    const path = rest.slice(q + 1, closeQ);
    const el = /element=\{<([A-Za-z]+)/.exec(rest.slice(closeQ));
    // ⚠️ 过滤掉不像路径的值。第一版偏移错了一格,把下一条路由的属性串当成了路径,
    // 生成出一行 ` element={<SetupPage />} /> ...` 那样的垃圾 —— 而它**看起来像一条路由**。
    // 生成器编出不存在的东西,比漏掉更危险:它会被当成事实写进文档。
    if (!(path.startsWith('/') || path === '*')) continue;
    out.push({ path, el: el === null ? '—' : el[1] });
  }
  return out;
}

function renderPages() {
  const rows = extractPages();
  const out = [
    '| 路径 | 组件 |',
    '|---|---|',
  ];
  for (const r of rows) {
    out.push('| ' + '`' + r.path + '`' + ' | ' + '`' + r.el + '`' + ' |');
  }
  out.push('');
  out.push('共 **' + String(rows.length) + '** 条。由 `scripts/gen-doc.mjs` 从 `App.tsx` 生成。');
  return out.join('\n');
}

// ============================================================
// 5) 写回 / 校验
// ============================================================

/** 所有生成块:名字 → 生成内容。 */
const BLOCKS = {
  routes: { title: '接口清单', render: renderRoutes },
  models: { title: '数据模型', render: renderModels },
  env: { title: '环境变量', render: renderEnv },
  pages: { title: '前端路由', render: renderPages },
};

/**
 * 把文档里某个生成块替换成新内容。
 *
 * ⚠️ 找不到标记就直接抛错,而不是"跳过这一块"。
 * 静默跳过的话,某天有人删了标记,校验会**永远通过** —— 而文档已经不再被生成覆盖,
 * 那正是旧文档烂掉的起点(没人发现它不再对账了)。
 */
function replaceBlock(text, name, body) {
  const begin = beginMarker(name);
  const end = endMarker(name);
  const i = text.indexOf(begin);
  const j = text.indexOf(end);
  if (i < 0 || j < 0 || j < i) {
    throw new Error('文档里缺少生成块标记: ' + name + '(需要 ' + begin + ' 与 ' + end + ')');
  }
  return text.slice(0, i + begin.length) + String.fromCharCode(10) + body + String.fromCharCode(10) + text.slice(j);
}

function renderAll(text) {
  let out = text;
  for (const [name, block] of Object.entries(BLOCKS)) out = replaceBlock(out, name, block.render());
  return out;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const original = read(DOC);
  const next = renderAll(original);
  if (next === original) {
    console.log('文档里的生成块与代码一致');
    return;
  }
  if (checkOnly) {
    console.error('❌ 文档里的事实表格与代码不一致 —— 跑 `node scripts/gen-doc.mjs` 重新生成。');
    process.exitCode = 1;
    return;
  }
  writeFileSync(join(ROOT, DOC), next, 'utf8');
  console.log('已重新生成文档里的四张事实表格');
}

main();
