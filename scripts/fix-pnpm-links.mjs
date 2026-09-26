/**
 * ⚠️ 这是**仅 Windows 本地开发**才需要的工具脚本,Linux / Docker 构建完全用不到。
 *
 * 背景:某些 Windows 环境下 pnpm 对**新加的依赖**会静默不创建符号链接
 * (作用域目录建了、里面是空的),表现为 Cannot find module,
 * 以及 Tiptap 这类靠 declare module 做类型增强的库,命令方法集体消失。
 * pnpm 自己会报 Done,--force 也「成功」,所以必须靠对账才能发现。
 *
 * 用法(仅当本地 typecheck/build 报找不到模块时):
 *   node scripts/fix-pnpm-links.mjs .
 *   node scripts/fix-pnpm-hoist.mjs .
 *
 * 详细说明见 ~/.workbuddy/skills/pnpm-symlink-repair/。
 */
/**
 * 修复本机 pnpm 未创建的 workspace 依赖符号链接。
 *
 * 背景:本机沙箱里 pnpm 对**新加的**依赖没有在
 * `apps/web/node_modules/` 下创建符号链接(作用域目录建了,里面的链接没建),
 * 表现为 `Cannot find module '@tiptap/react'`。
 * 这不是仓库的问题 —— Docker 里是干净安装,不受影响。
 *
 * 做法:按 pnpm-lock.yaml 的 importers 段,逐个 workspace 项目
 * 检查它声明的每个依赖在 store 里有没有对应的符号链接,缺了就补。
 * 用 junction(Windows 下不需要管理员权限)。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').split('\n');

/** 解析出 { 项目相对路径: { 依赖名: 版本 } }。 */
function parseImporters(lines) {
  const importers = {};
  let current = null;
  let pendingName = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 顶层段结束
    if (/^[a-zA-Z]/.test(line)) {
      current = null;
      pendingName = null;
      continue;
    }

    // 项目块:`  apps/web:`
    const project = /^ {2}(\S.*):$/.exec(line);
    if (project) {
      const key = project[1].replace(/^['"]|['"]$/g, '');
      current = key === '.' ? {} : null;
      importers[key] = current ?? {};
      current = importers[key];
      pendingName = null;
      continue;
    }

    if (current === null) continue;

    // 依赖名:`      '@tiptap/react':`
    const dep = /^ {6}(\S.*):$/.exec(line);
    if (dep) {
      pendingName = dep[1].replace(/^['"]|['"]$/g, '');
      continue;
    }

    // 版本:`        version: 3.31.3(peer...)`
    if (pendingName !== null) {
      const version = /^ {8}version: (\S+)$/.exec(line);
      if (version) {
        // 去掉 peer 后缀 `(react@18.3.1)`
        const clean = version[1].replace(/^['"]|['"]$/g, '').split('(')[0];
        current[pendingName] = clean;
        pendingName = null;
      }
    }
  }

  return importers;
}

const importers = parseImporters(lock);
const storeDir = join(root, 'node_modules', '.pnpm');
const store = readdirSync(storeDir);

/** 包名 → store 里的目录名前缀。`@tiptap/react` → `@tiptap+react` */
const encode = (name) => name.replace(/\//g, '+');

let created = 0;
let checked = 0;
let broken = 0;

for (const [project, deps] of Object.entries(importers)) {
  const projectDir = project === '.' ? root : join(root, project);
  if (!existsSync(projectDir)) continue;

  for (const [name, version] of Object.entries(deps)) {
    checked += 1;
    const linkPath = join(projectDir, 'node_modules', name);

    // 已经能用就跳过(注意:断链的符号链接 existsSync 会返回 false,
    // 所以这里用 realpath 判断"是否真的指向一个存在的目录")
    let ok = false;
    try {
      realpathSync(linkPath);
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) continue;

    // ⚠️ 不能按 `名字@版本` 精确匹配:pnpm 的 `virtualStoreDirMaxLength` 会把
    // store 目录名截断(`@tiptap+extension-image@3.3_<hash>`),
    // 版本号在目录名里根本不全。改成按名字前缀找候选,再读 package.json 核对版本。
    const candidates = store.filter((entry) => entry.startsWith(`${encode(name)}@`));

    const target = candidates
      .map((entry) => join(storeDir, entry, 'node_modules', name))
      .find((candidate) => {
        if (!existsSync(candidate)) return false;
        try {
          const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
          return pkg.version === version;
        } catch {
          return false;
        }
      });

    if (target === undefined) {
      console.log(`  ⚠️  store 里找不到 ${name}@${version}`);
      broken += 1;
      continue;
    }

    // 断链:先删掉再建(lstat 能识别断链,existsSync 不能)
    try {
      if (lstatSync(linkPath)) {
        // 已存在的真实目录(少见):不动它
        if (!lstatSync(linkPath).isSymbolicLink()) continue;
        // 断链的符号链接:删掉重建
        const { unlinkSync } = await import('node:fs');
        unlinkSync(linkPath);
      }
    } catch {
      // 不存在,直接建
    }

    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath, 'junction');
    console.log(`  ✅ 补齐 ${project}/${name}@${version}`);
    created += 1;
  }
}

console.log(`\n检查 ${checked} 个依赖,补齐 ${created} 个,失败 ${broken} 个`);
