/**
 * 文档与代码的**漂移检查**。
 *
 * ## 为什么需要它
 *
 * 这个项目的施工依据是 `DESIGN.md`,但它是**手写的** ——
 * 手写的清单一定会漂:接口加了没写进去、表改名了文档没跟着改、
 * 环境变量写了但代码根本不读。这类漂移**不会报任何错**,
 * 只会在某天有人照着文档去做一件事、却发现文档是错的。
 *
 * 实测发现的例子(都是这一轮修掉的):
 *   · §9.1 一边写"`pnpm verify:m4m5` 已删除",一边写"脚本在仓库里,可以自己复现"
 *   · §10 的"硬约束"里还写着 v1.x 的表名 `page_id` / `page_contents`
 *   · `.env.example` 里的 `POSTGRES_PORT` / `VITE_API_BASE` **没有任何一处读**
 *     —— 填了不生效的开关比没有开关更坏
 *   · `/health` 与 `/health/ready` 两个接口根本没进接口清单
 *
 * ## 检查四件事
 *
 * 1. **接口**:`DESIGN.md` §6.2 的表格 ↔ 控制器里实际注册的路由,双向比对
 * 2. **环境变量**:`process.env.X` ↔ `.env.example` 的键,双向比对
 * 3. **文件路径**:文档里提到的仓库路径是否真的存在
 * 4. **版本号**:文档头写的版本 = 变更记录里最新一行的版本
 *
 * 用法:`pnpm audit:docs`(退出码非 0 表示有漂移)
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

// ============================================================
// 1) 接口清单
// ============================================================

/**
 * 文档里写了、但**故意不实现**的路由(§6.2 的「阶段二占位」表)。
 * 键必须是 `normalizeRoute` 之后的形式 —— 第一版用原始字符串比,
 * 于是 `WS /collab?nodeId=&token=` 没匹配上 `/collab`,检查器自己报了假漂移。
 */
const PLANNED_ONLY = new Set([normalizeRoute('WS', '/collab')]);

/** 把 `:id` / `:nodeId` / `:userId` 归一成同一个形状(参数名不同不算漂移)。 */
function normalizeRoute(method, routePath) {
  return `${method} ${routePath.split('?')[0].replace(/:[A-Za-z]+/g, ':p').replace(/\/$/, '')}`;
}

const designText = read('DESIGN.md');
const apiSection = designText.slice(
  designText.indexOf('### 6.2 接口清单'),
  designText.indexOf('## 7. 前端架构'),
);

const docRoutes = new Map();
for (const line of apiSection.split('\n')) {
  const m = /^\|\s*(GET|POST|PUT|PATCH|DELETE|WS)\s*\|\s*`([^`]+)`/.exec(line);
  if (m === null) continue;
  const key = normalizeRoute(m[1], m[2]);
  docRoutes.set(key, `${m[1]} ${m[2]}`);
}

const codeRoutes = new Map();
const apiSrc = path.join(ROOT, 'apps/api/src');
for (const file of fs.readdirSync(apiSrc, { recursive: true })) {
  const rel = path.join('apps/api/src', String(file));
  if (!rel.endsWith('.controller.ts')) continue;
  const src = read(rel);
  const prefix = /@Controller\(\s*'([^']*)'\s*\)/.exec(src)?.[1] ?? '';
  for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)) {
    const full = `/${[prefix, m[2] ?? ''].filter((p) => p !== '').join('/')}`;
    codeRoutes.set(normalizeRoute(m[1].toUpperCase(), full), `${m[1].toUpperCase()} ${full}`);
  }
}

for (const [key, label] of docRoutes) {
  if (codeRoutes.has(key) || PLANNED_ONLY.has(key)) continue;
  fail(`接口漂移:文档写了 \`${label}\`,但代码里没有这条路由`);
}
for (const [key, label] of codeRoutes) {
  if (docRoutes.has(key)) continue;
  fail(`接口漂移:代码里有 \`${label}\`,但 §6.2 没写`);
}
notes.push(`接口:文档 ${String(docRoutes.size)} 条 / 代码 ${String(codeRoutes.size)} 条,已双向比对`);

// ============================================================
// 2) 环境变量
// ============================================================

/**
 * 声明了但"我们的 TS 不读"是**正常的** —— 有的是别的程序读的。
 * 每一条都必须给出理由,否则迟早会有人把真的死开关塞进这个名单。
 */
const ENV_READ_ELSEWHERE = new Map([
  ['SHADOW_DATABASE_URL', 'Prisma CLI 直接读它(migrate dev 建影子库),不经过我们的代码'],
  ['POSTGRES_USER', 'docker-compose 用它初始化 postgres 容器'],
  ['POSTGRES_PASSWORD', 'docker-compose 用它初始化 postgres 容器'],
  ['POSTGRES_DB', 'docker-compose 用它初始化 postgres 容器'],
  ['WEB_PORT', 'docker-compose 用它做端口映射'],
]);

const codeVars = new Set();
for (const file of fs.readdirSync(apiSrc, { recursive: true })) {
  const rel = path.join('apps/api/src', String(file));
  if (!rel.endsWith('.ts')) continue;
  const src = read(rel);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) codeVars.add(m[1]);
  for (const m of src.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) codeVars.add(m[1]);
}

const envExample = new Map();
for (const line of read('.env.example').split('\n')) {
  const m = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
  if (m !== null) envExample.set(m[1], line.trim());
}

const composeVars = new Set([...read('docker-compose.yml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));

/** 这些由运行环境或 Node 自己提供,不该写进 .env.example。 */
const ENV_EXTERNAL = new Set(['NODE_ENV', 'TZ', 'HOST', 'PORT']);

for (const name of codeVars) {
  if (envExample.has(name) || ENV_EXTERNAL.has(name)) continue;
  fail(`环境变量漂移:代码读 \`${name}\`,但 .env.example 没声明`);
}
for (const name of envExample.keys()) {
  if (codeVars.has(name) || composeVars.has(name) || ENV_READ_ELSEWHERE.has(name)) continue;
  fail(`环境变量漂移:\`${name}\` 在 .env.example 里声明,但**没有任何一处读它**(填了不生效)`);
}
notes.push(`环境变量:代码读 ${String(codeVars.size)} 个 / .env.example 声明 ${String(envExample.size)} 个,已双向比对`);

// ============================================================
// 3) 文件路径
// ============================================================

/**
 * 只检查**看起来明确指向仓库内**的引用(带 `apps/`、`packages/`、`scripts/` 前缀,
 * 或形如 `目录/文件.ext`)。不这么做的话,"h1/h2/h3"、"try/finally"
 * 这类字面量会被误判 —— 第一版就栽在这里。
 */
/**
 * 有意为之的引用,不必存在。**每一条都必须写理由** ——
 * 没有理由的名单迟早会变成"把报错塞进去就完事"的地方,那时这个检查就死了。
 */
const HISTORICAL = new Map([
  ['apps/api/scripts/verify-m4m5.mjs', '§9.1 是历史记录,文中已明确写了"v2.0 改造时已删除"'],
  ['packages/shared/src/roles.ts', '只出现在 v1.5 的变更记录里,那是对当时状态的存档'],
  ['features/pages', 'DEPLOY.md 说明"某个版本删掉的前端模块会原样留着"'],
  ['docker-compose.override.yml', '部署侧文件,不进仓库'],
  ['backups/', '运行期目录,不进仓库'],
  [
    'apps/api/src/generated',
    'Prisma 客户端,**由 `prisma generate` 生成**:本地有(装依赖时跑过)、' +
      '服务器上那份源码包里没有(它被 tar 排除、改在镜像构建时生成)。' +
      '文档引用它是正确的 —— 它是 import 路径的一部分。',
  ],
]);

/**
 * 搜索根目录。文档里的引用有两种写法:
 *   · 从仓库根写起 —— `apps/web/src/lib/api.ts`
 *   · 从某个 src 写起 —— `lib/typography.ts` / `org/import.core.ts` / `audit/record.ts`
 * 所以根目录列表必须覆盖各个 `src`,否则后者全会被误判成"找不到"
 * (第一版就漏了它们,一次报 6 个假漂移)。
 */
const ROOTS = [
  '',
  'apps/api/src/',
  'apps/web/src/',
  'packages/shared/src/',
  'apps/api/prisma/',
  'apps/api/scripts/',
  'scripts/',
  'docker/',
];
const EXTS = /\.(ts|tsx|mjs|js|json|prisma|sql|css|md|yml|yaml|sh|html)$/;
/** 占位符写法(如 `apps/web/node_modules/<包>`)不是真的路径引用。 */
const PLACEHOLDER = /[<>…]|xxx|\*/;
/**
 * `node_modules/` 下的引用一律跳过:那是**安装产物**,永远不在仓库里,
 * 而且在不在取决于"这台机器装没装依赖" —— 拿它当漂移报是错的。
 * (这条不是"例外名单",是一条规则:`node_modules` 天生不属于仓库内容。)
 */
const INSTALLED = /(^|\/)node_modules\//;

const pathRefs = new Set();
for (const doc of ['DESIGN.md', 'DEPLOY.md', 'README.md']) {
  if (!fs.existsSync(path.join(ROOT, doc))) continue;
  for (const m of read(doc).matchAll(/`([^`\n]+)`/g)) {
    const ref = m[1].trim();
    if (PLACEHOLDER.test(ref) || INSTALLED.test(ref)) continue;
    const looksRepoPath =
      /^(apps|packages|scripts|docker)\//.test(ref) ||
      (/^[\w-]+\/[\w./-]+$/.test(ref) && EXTS.test(ref));
    if (looksRepoPath) pathRefs.add(ref);
  }
}

/** 例外名单里既有具体文件也有目录 —— 目录用前缀匹配(如 `apps/api/src/generated`)。 */
function isExcepted(ref) {
  for (const key of HISTORICAL.keys()) {
    if (ref === key || ref.startsWith(key.endsWith('/') ? key : `${key}/`)) return true;
  }
  return false;
}

for (const ref of pathRefs) {
  if (isExcepted(ref)) continue;
  // 去掉可能带的 `:` 行号后缀
  const clean = ref.split(':')[0];
  const found = ROOTS.some((root) => fs.existsSync(path.join(ROOT, root, clean)));
  if (!found) fail(`路径漂移:文档提到 \`${ref}\`,但仓库里找不到`);
}
notes.push(`文件路径:检查 ${String(pathRefs.size)} 个引用`);

// ============================================================
// 4) 版本号:文档头 = 变更记录最新一行
// ============================================================

const headerVersion = /\|\s*文档版本\s*\|\s*(v[\d.]+)\s*\|/.exec(designText)?.[1];
const changelogVersions = [...designText.matchAll(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*(v[\d.]+)\s*\|/gm)].map((m) => m[1]);
const latest = changelogVersions.at(-1);

if (headerVersion === undefined) fail('版本漂移:文档头找不到「文档版本」');
else if (latest !== undefined && headerVersion !== latest) {
  fail(`版本漂移:文档头写 ${headerVersion},但变更记录最新一行是 ${latest}`);
} else {
  notes.push(`版本号:文档头 ${String(headerVersion)} = 变更记录最新一行`);
}

// ============================================================
// 输出
// ============================================================

console.log('文档与代码漂移检查\n');
for (const note of notes) console.log(`  · ${note}`);

if (problems.length === 0) {
  console.log('\n✅ 未发现漂移');
  process.exit(0);
}

console.log(`\n❌ 发现 ${String(problems.length)} 处漂移:\n`);
for (const problem of problems) console.log(`  - ${problem}`);
console.log(
  '\n修法:改文档,或改代码 —— 但**必须选一个**。' +
    '若确认是有意为之(例如历史存档),把它加进本脚本的例外名单并写清理由。',
);
process.exit(1);
