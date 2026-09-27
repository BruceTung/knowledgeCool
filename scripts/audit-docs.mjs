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
 * ## 检查八件事
 *
 * 1. **接口**:`DESIGN.md` §6.2 的表格 ↔ 控制器里实际注册的路由,双向比对
 *    (文档少的、多的都报 —— 单向比对会漏掉「代码里有、文档没写」)
 * 2. **环境变量**:`process.env.X` ↔ `.env.example` 的键,双向比对
 * 3. **文件路径**:文档里提到的仓库路径是否真的存在
 * 4. **版本号**:文档头写的版本 = 变更记录里最新一行的版本
 * 5. **前端调用 ↔ 后端路由**:前端写的字符串路径必须都能在后端找到。
 *    这类错是「后端删了路由、前端还在调」,静态检查都不报,点下去才是 404。
 * 6. **docker-compose ↔ 代码**:compose 传给 api 的环境变量必须是代码真读的。
 *    填了不生效的开关比没有开关更坏(有人会去调它,然后奇怪为什么没反应)。
 * 7. **弃用结构**:数据库里已删的列与索引不许再出现在源码里
 *    (裸 SQL 不参与类型检查,`deleted_at` 那次就是这么漏过去的)。
 * 8. **生成块**:`DESIGN.md` 里由 `scripts/gen-doc.mjs` 生成的四张事实表
 *    (接口 / 数据模型 / 环境变量 / 前端路由)必须与代码一致。
 *    这一条是"文档可信"的**机制保证**:表格是生成的,不是手抄的。
 *
 * 用法:`pnpm audit:docs`(退出码非 0 表示有漂移);`node scripts/gen-doc.mjs` 重新生成表格。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  ['features/pages', 'v2.0 删掉的前端模块目录,历史上真实存在过'],
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
for (const doc of ['DESIGN.md']) {
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
// 4.5) 前端调用的路径 ↔ 后端注册的路由(v2.14 新增)
// ============================================================

/*
  ⚠️ 这一段的由来与下面那段(弃用结构扫描)是同一类事:
  **有一种 bug,静态检查三件套都抓不到,而它会让功能整个不可用。**

  前端调用后端用的是**字符串路径**,后端路由是装饰器里的字符串,
  两边在类型上没有任何联系 —— 于是「后端删了一条路由,前端还在调」这件事,
  typecheck / lint**全都不报**,表现是用户点下去得到 404,
  而开发者以为这次改动是干净的。

  这类错误在本仓库真实发生过:回收站移除时删掉了 /nodes/:id/restore 与 /trash,
  前端那几个 hook 是同一次改动里**手工**清掉的 —— 靠的是「记得」。
  而「记得」不是一种机制。这一段把它变成机制。
*/

/** 三种引号字符。用字符码构造,避免这一段源码里出现字面引号。 */
const QUOTES = [String.fromCharCode(96), String.fromCharCode(39), String.fromCharCode(34)];

/** 去掉字符串字面量的引号,只留内容。 */
function stripQuotes(text) {
  let out = text;
  for (const ch of QUOTES) out = out.replaceAll(ch, '');
  return out;
}

/**
 * 从调用参数里抽出「一条路径」。
 *
 * 三种写法都要认,因为仓库里三种都有:纯字面量、模板串、字符串拼接。
 * 拼接那条最容易被漏掉,也最危险 —— 「拼出来的路径」正是删路由时最容易忘的地方。
 *
 * 做法:先去掉引号,再把插值与拼接统一换成 :p,最后把连续的 :p 收成一个。
 * 不用逐字符解析 —— 那种写法要比较引号字符,而生成这段代码时引号本身就是麻烦的来源。
 */
function extractPathArgument(raw) {
  const firstLine = raw.split(String.fromCharCode(10))[0];
  let text = stripQuotes(firstLine);
  // ⚠️ 顺序要紧:**先**把模板插值换成占位,**再**截断。
  // 反过来的话,`/nodes/${String(nodeId)}` 里的那个 ) 会被当成"参数结束",
  // 路径被截成 `/nodes/${String(nodeId`,于是这一批**每一条都报不匹配**
  // (第一次跑出来 10 处全挂在这上面)。
  text = text.replace(/\$\{[^{}]*\}/g, ':p');
  // 截到第一个 ) 或 , —— 那之后是别的参数(请求体、文件名…),不是路径的一部分。
  const cut = Math.min(
    ...[text.indexOf(')'), text.indexOf(',')].filter((i) => i >= 0),
    text.length,
  );
  text = text.slice(0, cut);
  text = text.replace(/\+\s*[^+]*\s*\+/g, ':p');
  text = text.replace(/\+/g, ':p');
  text = text.replace(/:p(\/:p)+/g, ':p');
  // 把拼接产生的小碎片与多余空白收拾干净,报告里才读得懂
  // (第一版报出来是 `/nodes/ :p /restore`,像是有空格 —— 其实是拼接碎片)
  return text
    .replace(/\s*:p\s*/g, '/:p/')
    .replace(/\/+/g, '/')
    .trim();
}

/** 把前端写出来的路径归一成与后端路由同一种形状。 */
function normalizeClientPath(raw) {
  const withoutQuery = raw.split('?')[0];
  return (
    withoutQuery.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  );
}

{
  const QS = String.fromCharCode(39);
  const getLike = /api(?:Fetch|Download)(?:<[^>]*>)?\(\s*([^\n]*)/g;
  const sendLike = new RegExp(
    'api(?:Send|Upload)(?:<[^>]*>)?\\(\\s*(?:' + QS + '([A-Z]+)' + QS + '\\s*,)?\\s*([^\\n]*)',
    'g',
  );

  const clientFiles = [];
  for (const root of ['apps/web/src', 'packages/shared/src']) {
    const abs = path.join(ROOT, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs, { recursive: true })) {
      const rel = path.join(root, String(file));
      if (/\.(ts|tsx)$/.test(rel) && !/\.test\./.test(rel)) clientFiles.push(rel);
    }
  }

  let callCount = 0;
  const missing = [];
  for (const rel of clientFiles) {
    const src = read(rel);
    for (const m of src.matchAll(getLike)) {
      const raw = extractPathArgument(m[1]);
      if (!raw.startsWith('/')) continue;
      callCount += 1;
      const key = normalizeRoute('GET', normalizeClientPath(raw));
      if (!codeRoutes.has(key)) missing.push(rel + ' → GET ' + raw);
    }
    for (const m of src.matchAll(sendLike)) {
      const method = m[1] ?? 'POST';
      const raw = extractPathArgument(m[2]);
      if (!raw.startsWith('/')) continue;
      callCount += 1;
      const key = normalizeRoute(method, normalizeClientPath(raw));
      if (!codeRoutes.has(key)) missing.push(rel + ' → ' + method + ' ' + raw);
    }
  }

  for (const item of missing) {
    fail(
      '前端调了不存在的路由:' + item +
        '(后端没有这条 —— 点了会是 404,而静态检查不会报)',
    );
  }
  notes.push(
    '前端调用:检查 ' + String(callCount) + ' 处,未匹配 ' + String(missing.length) + ' 处',
  );
}

// ============================================================
// 4.7) docker-compose 传给 api 的环境变量必须是代码真的读的(v2.14 新增)
// ============================================================

/*
  ⚠️ 这一条是**在真机上部署时**发现的:`docker-compose.yml` 里一直留着
  TRASH_RETENTION_DAYS / TRASH_PURGE_INTERVAL_HOURS,而 v2.12 移除回收站之后
  代码**再也不读**它们了 —— 也就是两个死开关。

  为什么原来没被发现:第 2 节检查的是 process.env.X 与 .env.example 的键,
  而 **compose 是第三个地方**,没人管。填了不生效比没有这个开关更坏:
  有人会去调它,然后奇怪为什么没反应。

  这里只检查 **api 服务**的 environment 块 —— 我们自己的代码读那些键。
  postgres / redis 服务的变量是给官方镜像用的(POSTGRES_* 等),不归我们管;
  把它们一起检查会立刻产生一堆假告警,而假告警会让人关掉整个检查。
*/

{
  const compose = read('docker-compose.yml');
  const apiStart = compose.indexOf('  api:');
  const apiEnd = compose.indexOf('  # ---------------- 前端', apiStart);
  const apiBlock = apiStart >= 0 && apiEnd > apiStart ? compose.slice(apiStart, apiEnd) : '';

  // 只取「六个空格缩进的 KEY:」—— 那是 environment: 下的键
  const composeKeys = [...apiBlock.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);

  const unused = composeKeys.filter((key) => !codeVars.has(key));
  for (const key of unused) {
    fail(
      `死开关:docker-compose 给 api 传了「${key}」,但**代码从不读它**;` +
        ' 填了不生效比没有这个开关更坏',
    );
  }
  notes.push(
    `docker-compose:给 api 传 ${String(composeKeys.length)} 个环境变量,` +
      `其中代码不读的 ${String(unused.length)} 个`,
  );
}

// ============================================================
// 4.9) 文档里的事实表格必须与代码一致(v3.0 新增)
// ============================================================

/*
  旧文档烂掉的根因不是"写得不用心",而是**它的事实来自记忆**:
  接口表、字段表、环境变量表都是手抄的,抄完之后没有任何东西会发现它与代码不符。

  现在接口 / 数据模型 / 环境变量 / 前端路由四张表由 `scripts/gen-doc.mjs`
  **从代码生成**,包在 `<!-- BEGIN GENERATED:… -->` 标记之间。
  这里重新生成一遍并逐字比对 —— 一旦不一致就直接失败。

  ⚠️ 用**子进程重新跑生成器**而不是 import 它的函数:
  生成器是"读代码、产出文本"的独立程序,它的入口就是命令行。
  import 进来要处理它顶层的副作用,反而更脆。
*/

{
  const generated = spawnSync(process.execPath, ['scripts/gen-doc.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (generated.status !== 0) {
    fail(
      '文档里的事实表格与代码不一致 —— 跑 `node scripts/gen-doc.mjs` 重新生成' +
        (generated.stderr === '' ? '' : '\n' + generated.stderr.trim()),
    );
  } else {
    notes.push(
      `生成块:接口/数据模型/环境变量/前端路由四张表已与代码比对`,
    );
  }
}

// ============================================================
// 5) 源码里不该再出现的弃用结构(v2.14 新增)
// ============================================================

/*
  ⚠️ 这一段是**被一个真 bug 逼出来的**。

  v2.12 移除了回收站:迁移里 `DROP COLUMN deleted_at / deleted_by`。
  但 `search.service.ts` 的**裸 SQL** 里一直留着 `WHERE n.deleted_at IS NULL` ——
  而裸 SQL 不参与 TypeScript 检查,所以 typecheck / lint全都没报。
  真跑起来的表现是:检索接口直接 500(`column n.deleted_at does not exist`)。

  更值得记的是**为什么原来的守卫没拦住**:仓库里其实已经有一条检查 ——
  `apps/api/scripts/verify-db.mjs` 的 `FORBIDDEN_NODE_COLUMNS`,而且注释里
  恰好写着「代码里会重新出现 deleted_at 过滤,但没有任何地方会报错」。
  问题是那个脚本**需要连数据库**才能跑,日常门禁(`typecheck / lint / test`)里不会执行它,
  所以它在最需要的时候是缺席的。

  这一段的职责就是把它搬到**每次都会跑**的地方:直接扫源码文本。
  扫文本当然做不到精确(注释里提到也会命中),所以只针对那几个
  「数据库里已经删掉、代码里再出现就是 bug」的名字,而且允许用
  `// audit-docs:allow` 在同一行显式豁免 —— 迁移文件与说明性注释就是这么处理的。
*/

/** 数据库里已经不存在、源码里再出现即为 bug 的名字。 */
const FORBIDDEN_IN_SOURCE = [
  { pattern: /\bdeleted_at\b/, why: '回收站已移除(v2.12),nodes 上没有这一列' },
  { pattern: /\bdeleted_by\b/, why: '回收站已移除(v2.12),nodes 上没有这一列' },
  { pattern: /\bnodes_alive_idx\b/, why: '软删除的部分索引已移除(v2.12)' },
];

/** 允许豁免的地方:迁移与验收脚本要按名字描述"这些结构已经没了"。 */
const FORBIDDEN_SCAN_ROOTS = ['apps/api/src', 'apps/web/src', 'packages/shared/src'];
const FORBIDDEN_SCAN_EXCLUDE = [/\/generated\//];

function walkSource(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // ⚠️ 归一化之后再匹配排除规则 —— Windows 上 path.join 给的是反斜杠,
    // 而排除规则写的是正斜杠,不归一化会**一条都匹配不上**。
    // (生成目录必须排除:Prisma 会把 schema 里的注释一起复制进生成物,
    //  于是"说明这个索引已经删掉了"的那句注释反而会命中检查。)
    const normalized = full.replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      if (FORBIDDEN_SCAN_EXCLUDE.some((re) => re.test(normalized))) continue;
      walkSource(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

{
  let scanned = 0;
  let hits = 0;
  for (const root of FORBIDDEN_SCAN_ROOTS) {
    for (const file of walkSource(path.join(ROOT, root), [])) {
      scanned += 1;
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.includes('audit-docs:allow')) return;
        for (const rule of FORBIDDEN_IN_SOURCE) {
          if (rule.pattern.test(line)) {
            hits += 1;
            fail(
              `弃用结构:${rel}:${String(index + 1)} 还在用「${rule.pattern.source}」—— ${rule.why};` +
                ' 确需在注释里提到它,就在那一行加 audit-docs:allow',
            );
          }
        }
      });
    }
  }
  notes.push(`弃用结构:扫描 ${String(scanned)} 个源文件,命中 ${String(hits)} 处`);
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
