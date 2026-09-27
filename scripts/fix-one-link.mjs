/**
 * 修复本机 pnpm 装完之后的**两处缺链接**。
 *
 * ## 症状
 *
 * `pnpm install` 报 `Done` / `Already up to date`,但:
 *   1. `apps/web/node_modules/<包>` 不存在 —— 应用里 `import` 直接解析失败;
 *   2. 即使这一层建好了,包**自己的依赖**在 store 里也可能是空的 ——
 *      加载时报 `MODULE_NOT_FOUND`,而错误指向 store 深处的文件,
 *      看起来像"这个包坏了",其实只是链接缺失。
 *
 * 实测踩到(`@tiptap/extension-code-block-lowlight`):
 *   `node_modules/.pnpm/@tiptap+extension-code-bloc_<hash>/node_modules/` 下
 *   只有它自己,`@tiptap/core` / `@tiptap/extension-code-block` / `@tiptap/pm` /
 *   `highlight.js` / `lowlight` 全都没链接上。
 *
 * ## 四个坑(都实测踩过,别再踩)
 *
 * 1. **不要按"目录名前缀 == 包名"去 store 里找。**
 *    pnpm 会把过长的名字截断成 `@tiptap+extension-code-bloc_<hash>` ——
 *    前缀匹配既可能一个都匹配不到,也可能匹配到同前缀的另一个包
 *    (`extension-code-block` 与 `extension-code-block-lowlight` 的前 26 个字符
 *    完全一样)。**唯一可靠的做法是遍历 store,看哪一层真的包含它。**
 *
 * 2. **不要用 `fs.realpathSync()` 去求 junction 的真实路径 —— Windows 上它不解析。**
 *    实测:`realpathSync('apps/web/node_modules/@tiptap/extension-code-block-lowlight')`
 *    返回的还是那条 junction 自己的路径。于是 `path.dirname(...)` 算出来的是
 *    **应用层的目录**,依赖就被链到了 `apps/web/node_modules/@tiptap/` 下面 ——
 *    既没解决问题,还留下一堆垃圾。正确做法:**只认 store 里的路径**,不经过应用层。
 *
 * 3. **`@scope/name` 不能只 `dirname` 一次。**
 *    要放依赖的位置是 store 那一层的 `node_modules`,它在作用域目录**再上一层**:
 *      · `lodash`       → `<store>/node_modules/lodash`       → 上溯 1 层
 *      · `@types/node`  → `<store>/node_modules/@types/node`  → 上溯 2 层
 *    这里改为直接用 entry 路径拼出来,不用 `dirname` 数层数 —— 少一次推理就少一次错。
 *
 * 4. **Windows 用 junction**(目录联接,不需要管理员权限),
 *    且 `fs.symlinkSync(target, path, 'junction')` 必须给**绝对路径**。
 *    删除时用 `fs.rmdirSync(链接路径)` —— 它只摘掉链接,不动目标。
 *
 * ## ⚠️ 这个脚本**只做加法,不做清理**
 *
 * 曾经加过一段"顺手把误建的链接删掉"的自愈逻辑,判断是
 * 「作用域目录里除了本包之外的非 `@` 开头的条目就是垃圾」——
 * **那是错的**:`apps/web/node_modules/@tiptap/` 下本来就该有
 * core / react / starter-kit 等 8 个包。它一次删掉了 7 条**合法**链接
 * (幸好 junction 只摘链接不动实体,已从 store 原样恢复)。
 *
 * **教训:清理逻辑的删除条件必须能从"正确状态"推导出来,而不是从"看起来多余"推导。**
 * 这条脚本的价值是修复环境,一旦它自己会误删,它就成了比故障更危险的东西 ——
 * 所以现在它只建不删。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE = path.join(ROOT, 'node_modules', '.pnpm');
const WEB_MODULES = path.join(ROOT, 'apps', 'web', 'node_modules');

/**
 * 在 store 里找出这个包的候选目录。
 *
 * 返回 `{ real, hostModules, entry }[]`。**同一个包在 store 里可能有多个版本** ——
 * 挑哪一个必须谨慎(挑错版本会让"看起来修好了"变成一种更隐蔽的坏)。
 * 挑选规则见 `pickInStore`。
 */
function candidatesInStore(packagePath) {
  const scoped = packagePath.replace('/', '+');
  const preferred = [];
  const fallback = [];

  for (const entry of fs.readdirSync(STORE)) {
    const hostModules = path.join(STORE, entry, 'node_modules');
    const real = path.join(hostModules, packagePath);
    if (!fs.existsSync(real)) continue;
    const item = { real, hostModules, entry };
    // `<名字>@<版本>` 形式的目录才是"这个包自己的那一层"。
    // 其他包含它的目录通常是别人(截断名)的层 —— 只有在找不到正主时才用。
    if (entry.startsWith(`${scoped}@`)) preferred.push(item);
    else fallback.push(item);
  }
  return preferred.length > 0 ? preferred : fallback;
}

/**
 * 从候选里挑一个。
 *
 * **按"多数版本"挑**:同一个包在 store 里往往只有一个是本项目真正用的版本,
 * 其余是别的依赖带进来的旧版本。多数派几乎总是对的那个;
 * 平票时取版本号字符串最大的(粗略但确定 —— 不追求语义化比较的正确性,
 * 因为这是个修复工具,选错也只会影响一个被跳过/被链错的**旁支**依赖)。
 *
 * 有多个版本被挑过时会打印出来 —— 让使用者知道这里有判断,不是无脑取第一个。
 */
function pickInStore(packagePath) {
  const candidates = candidatesInStore(packagePath);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const byVersion = new Map();
  for (const item of candidates) {
    const pkgJson = path.join(item.real, 'package.json');
    let version = '(未知)';
    if (fs.existsSync(pkgJson)) {
      try {
        version = String(JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version ?? '(未知)');
      } catch {
        /* 坏掉的 package.json 就当未知 */
      }
    }
    const bucket = byVersion.get(version) ?? [];
    bucket.push(item);
    byVersion.set(version, bucket);
  }

  const ranked = [...byVersion.entries()].sort(
    (a, b) => b[1].length - a[1].length || b[0].localeCompare(a[0]),
  );
  const [chosenVersion, chosen] = ranked[0];
  const others = ranked
    .slice(1)
    .map(([version, list]) => `${version}(${String(list.length)})`)
    .join('、');
  console.log(
    `      ↳ ${packagePath} 有多个版本,选了 ${chosenVersion}${others === '' ? '' : `,另有 ${others}`}`,
  );
  return chosen[0];
}

/** 建一条 junction(junction 必须用绝对路径)。 */
function junction(linkPath, realPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(realPath, linkPath, 'junction');
}

/**
 * 确保某个包在 store 那一层能解析到它自己的依赖。
 *
 * 只看 `dependencies` 与 `peerDependencies` —— `devDependencies` 不影响运行。
 * 找不到的**不报错**:有些 peer 是可选的,或在 store 里以别的名字出现。
 *
 * 返回**新补上的那些包的路径**,调用方据此继续往下修它的依赖
 * (缺链接是**传递**的:实测 `lowlight → devlop → dequal`,
 *  只修第一层会在运行时报 `Cannot find package 'dequal'`)。
 */
function repairDepsOf({ real, hostModules }) {
  const pkgJson = path.join(real, 'package.json');
  if (!fs.existsSync(pkgJson)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const wanted = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  const added = [];

  for (const name of wanted) {
    if (fs.existsSync(path.join(hostModules, name))) {
      // 已经有链接 —— 但它自己那一层可能也缺依赖,所以要继续往下走(见 repairClosure)
      added.push({ name, linked: false });
      continue;
    }
    const found = pickInStore(name);
    if (found === null) continue;
    junction(path.join(hostModules, name), found.real);
    added.push({ name, linked: true });
  }
  return added;
}

/**
 * 修一个包,并**沿完整依赖图往下修**。
 *
 * ⚠️ 关键:向下遍历**不能**只看"这次新补上的"。
 * 实测踩到:`lowlight → devlop` 这一层早就链好了,但 `devlop → dequal` 没链 ——
 * 只递归新增的话根本走不到 `devlop`,于是测试继续报 `Cannot find package 'dequal'`。
 * 缺链接是**沿整个子图**散布的,所以要把已存在的依赖也入队。
 *
 * 广度优先 + `visited` 去重 + `maxDepth` 兜底(依赖图理论上可能有环)。
 * 每个包只处理一次;它在 store 里出现多版本时由 `pickInStore` 决定用哪个。
 */
function repairClosure(rootName, maxDepth = 6) {
  const queue = [{ name: rootName, depth: 0, via: '' }];
  const visited = new Set();

  while (queue.length > 0) {
    const { name, depth, via } = queue.shift();
    if (visited.has(name) || depth > maxDepth) continue;
    visited.add(name);

    const found = pickInStore(name);
    if (found === null) {
      // 找不到不一定是问题:optional peer 常常不在 store 里
      if (via !== '' && depth <= 2) {
        console.log(`  · ${name}(由 ${via} 依赖)不在 store 里,跳过`);
      }
      continue;
    }

    const deps = repairDepsOf(found);
    const filled = deps.filter((dep) => dep.linked).map((dep) => dep.name);
    if (filled.length > 0) {
      const label = via === '' ? name : `${name}(由 ${via} 依赖)`;
      console.log(`  · ${label} 缺的依赖已补:${filled.join('、')}`);
    }

    if (depth < maxDepth) {
      for (const dep of deps) queue.push({ name: dep.name, depth: depth + 1, via: name });
    }
  }
}

/** 把某个包链到 apps/web。 */
function linkToApp(packagePath) {
  const found = pickInStore(packagePath);
  if (found === null) {
    console.log(`  ⚠️  store 里找不到 ${packagePath}`);
    return;
  }
  const target = path.join(WEB_MODULES, packagePath);
  if (fs.existsSync(target)) return;
  junction(target, found.real);
  console.log(`  ✅ ${packagePath} → ${path.relative(ROOT, found.real)}`);
}

/**
 * 按 `apps/web/package.json` **核对每一个直接依赖**,缺谁补谁。
 *
 * 比"手工列几个包名"可靠得多:那份列表一旦漏了某个包,症状是
 * `Cannot find module '@tiptap/extensions'` 这种**看起来像代码写错了**的报错 ——
 * 实测就是这么被误导过一次(以为是 import 有问题,其实是 node_modules 缺链接)。
 * 直接以 package.json 为准,就不会漏。
 *
 * `workspace:*` 指的是本仓库内的包,不在 pnpm store 里,跳过。
 */
function syncWebDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(WEB_MODULES, '..', 'package.json'), 'utf8'));
  const wanted = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ].filter((name) => !name.startsWith('@knowledgecool/'));

  const missing = [];
  for (const name of wanted) {
    if (fs.existsSync(path.join(WEB_MODULES, name))) continue;
    missing.push(name);
  }

  if (missing.length === 0) {
    console.log(`  ✅ apps/web 的 ${String(wanted.length)} 个依赖全部就位`);
    return;
  }

  console.log(`  ⚠️ 缺 ${String(missing.length)} 个直接依赖,开始补:`);
  for (const name of missing) repairClosure(name);
  for (const name of missing) linkToApp(name);
}

console.log('修复 pnpm 缺链接(沿依赖图补 store 内层,再链到应用层):');
for (const name of ['@tiptap/extension-code-block-lowlight', 'highlight.js', 'lowlight']) {
  repairClosure(name);
  linkToApp(name);
}
syncWebDependencies();

