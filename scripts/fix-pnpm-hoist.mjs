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
 * 修复 pnpm **隐藏提升层**(node_modules/.pnpm/node_modules)里缺失的符号链接。
 *
 * 本机沙箱里 pnpm 会创建作用域目录(如 @tiptap)却不在里面建链接,
 * 结果有两个可见后果:
 *   - TS 找不到 `@tiptap/extension-*` 的类型 → 命令增强(toggleBold 等)全部丢失;
 *   - 运行期 Vite / Node 也解析不到这些传递依赖。
 *
 * 规则与 pnpm 的 hoist 一致:**只提升在 store 里只有一个版本的包**
 * ——两个版本时提升谁是不确定的,乱建链接会指向错误的版本。
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 链接是否**真的**指向一个存在的目录。断链要用 realpath 判 —— existsSync 对断链返回 false。 */
function resolves(path) {
  try {
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

const root = resolve(process.argv[2] ?? process.cwd());
const hoistDir = join(root, 'node_modules', '.pnpm', 'node_modules');
const storeDir = join(root, 'node_modules', '.pnpm');

if (!existsSync(hoistDir)) {
  console.log('没有隐藏提升层,跳过');
  process.exit(0);
}

/** name → 出现在哪些 store 条目里。 */
const versions = new Map();

for (const entry of readdirSync(storeDir)) {
  if (entry === 'node_modules') continue;
  const inner = join(storeDir, entry, 'node_modules');
  if (!existsSync(inner)) continue;

  for (const name of readdirSync(inner)) {
    if (name === '.bin' || name === 'node_modules') continue;
    if (name.startsWith('@')) {
      const scopeDir = join(inner, name);
      for (const sub of readdirSync(scopeDir)) {
        push(`${name}/${sub}`, entry);
      }
    } else {
      push(name, entry);
    }
  }
}

function push(name, entry) {
  const list = versions.get(name) ?? [];
  list.push(entry);
  versions.set(name, list);
}

let created = 0;
let skippedMulti = 0;

for (const [name, entries] of versions) {
  if (entries.length !== 1) {
    skippedMulti += 1;
    continue;
  }

  const linkPath = join(hoistDir, name);
  // 已经能解析(含"指向真实存在目录"的链接)就跳过
  if (resolves(linkPath)) continue;

  const target = join(storeDir, entries[0], 'node_modules', name);
  if (!existsSync(target)) continue;

  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, 'junction');
  created += 1;
}

console.log(`提升层:补齐 ${created} 个链接(跳过 ${skippedMulti} 个"存在多版本"的包)`);
