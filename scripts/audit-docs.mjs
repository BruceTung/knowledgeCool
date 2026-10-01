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
 * ## 检查十二件事
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
 * 9. **章节引用**:文档与全部源码注释里的每一个 `§x.y` 都必须指得到真实的标题。
 *    ⚠️ 这一条是被旧文档的真实缺陷逼出来的:它把「§5.6」引用了 8 次
 *    (保密能力的说明散落在六处),而 **§5.6 那一节根本不存在** ——
 *    文档只写到 §5.3。源码注释里同样引用了它十几处。
 *    两头都在"看起来正常"的范围内,而**没有任何一处会去核对那个号存不存在**。
 * 10. **文档数量**:仓库里只允许有一篇 `*.md`(§0.3 的约定)。
 *     ⚠️ 这条约定原来**完全没有机制** —— 脚本里 `read('DESIGN.md')` 是硬编码的,
 *     把 `DEPLOY.md` 加回来门禁一样绿。而"同一件事散在两三篇里各自漂移"
 *     正是这份文档当初烂掉的起点,所以它必须是一条会被执行的规则。
 * 11. **界面字号刻度**:前端源码里不许出现任意值字号(`text-[13px]` 之类)。
 *     ⚠️ 这条规则原来由 `typography.test.ts` 执行,而"删除全部测试"之后
 *     规则还在、执行者没了 —— `MIN_FONT_PX` / `ALLOWED_ARBITRARY_PX`
 *     因此变成没人读的死常量。**文档说有门禁而门禁不存在,比没有规则更坏。**
 * 12. **§9.1 的环境变量表必须覆盖代码真读的每个键**。
 *     ⚠️ 第 8 项只比"生成物 ↔ 文档",第 2 项只比"代码扫描 ↔ `.env.example`",
 *     **没有任何一项把两者放在一起看**;而生成器每行只取第一个 `process.env.X`。
 *     于是"与别的变量写在同一行"的新变量会静默不进文档,而门禁全绿。
 *     ⚠️ 覆盖的判据是"在某一行的表达式里**真的引用了** `process.env.X`",
 *     不是"这个词出现过" —— 生成器会把行尾**注释**一起放进单元格,
 *     用裸词匹配的话一句注释就能让缺失的行蒙混过关(对抗性复核实测)。
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
 * 文档里写了、但**故意不实现**的路由。
 *
 * ⚠️ 这里现在是**空的**,而且是刻意的:原来只有一条 `WS /collab`,
 * 理由写的是"§6.2 的阶段二占位表" —— 而那张表**根本不存在**,
 * §6.2 里一条 `WS` 行都没有。一条永远不可能命中的豁免项是**不可证伪的**:
 * 它不会报错,也不会起任何作用,只会让下一个人以为"这里有豁免机制,可以往里加"。
 *
 * 所以真需要占位路由时,**先把它写进 §6.2,再把理由写在这里** ——
 * 在那之前,文档里有、代码里没有的路由一律报漂移。
 */
const PLANNED_ONLY = new Set();

/** 把 `:id` / `:nodeId` / `:userId` 归一成同一个形状(参数名不同不算漂移)。 */
function normalizeRoute(method, routePath) {
  return `${method} ${routePath
    .split('?')[0]
    .replace(/:[A-Za-z]+/g, ':p')
    .replace(/\/$/, '')}`;
}

const designText = read('DESIGN.md');

/**
 * 找一个**标题行**的偏移量。找不到返回 -1。
 *
 * ⚠️ **绝对不能用 `indexOf`** —— 它匹配的是"任意位置出现的子串"。
 * 而这份文档的**变更记录里原样引用了这些标题字符串**(v4.5 那条为了讲清这个
 * 缺陷,把 `## 7. 前端架构` 与 `## 7. 前端` 两种写法都写进了正文)。
 * 实测:这两个字符串在文档里各出现两次 —— 一次是真标题,一次在变更记录的正文里。
 *
 * 后果极其隐蔽:一旦有人改了真标题,`indexOf` 会在**变更记录里**命中,守卫以为
 * "找到了",切片却悄悄放宽到全文约 64%(一路含到附录),而门禁照样打印
 * 「未发现漂移」—— **这恰恰就是它要修的那个缺陷本身**(一次静默的范围退化)。
 * 一个用"字符串有没有出现"做守卫的检查,会被任何一句提到它的说明文字骗过去。
 *
 * 所以这里必须锚定到"行首的 `#` 开头、整行恰好就是这个标题"。
 */
function headingOffset(heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('^' + escaped + '[ \\t]*$', 'm').exec(designText);
  return match === null ? -1 : match.index;
}

/**
 * 取文档里两个**标题行**之间的一段。
 *
 * 旧写法把两个 `indexOf` 的结果直接喂给 `slice`,而结束标题当时写的是
 * `## 7. 前端架构`(真实标题是 `## 7. 前端`)—— `indexOf` 返回 **-1**,
 * 而 `String.slice(start, -1)` **不报错**,于是"接口区"静默变成从 §6.2
 * 一直到文档末尾的一大段。检查照常通过,只是 §7~§12 里任何长得像接口表的
 * 表格都会被当成真实路由收进来,而真正的漏写反而可能被这堆噪声掩盖。
 */
function sectionRange(startHeading, endHeading) {
  const start = headingOffset(startHeading);
  if (start < 0) throw new Error(`DESIGN.md 里找不到标题行「${startHeading}」`);
  const end = headingOffset(endHeading);
  if (end < 0) {
    throw new Error(`DESIGN.md 里找不到标题行「${endHeading}」(「${startHeading}」的范围终点)`);
  }
  if (end <= start) {
    throw new Error(`DESIGN.md 的「${endHeading}」不在「${startHeading}」之后 —— 范围不成立`);
  }
  return designText.slice(start, end);
}

const apiSection = sectionRange('### 6.2 接口清单', '## 7. 前端');

/*
  ⚠️ 结构性不变式,作为纵深防御:接口区是 §6.x 的**子节**,
  所以它里面**不该出现任何一级(`## `)标题** —— 范围终点本该正好停在
  下一个 `## ` 之前。一旦出现,就说明终点被锚到了更靠后的地方
  (实测那种退化的切片里会含 `## 8. 关键流程` / `## 9. 运维` / 附录)。

  用这条不变式而不是"占全文不超过 N%":比例是拍出来的阈值,
  会随文档与接口表正常增长而误报;而"子节里不该有一级标题"是结构事实。
*/
if (/^## /m.test(apiSection)) {
  throw new Error('DESIGN.md 的接口区里出现了一级标题 —— 范围终点锚错了,切片已过宽');
}

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
notes.push(
  `接口:文档 ${String(docRoutes.size)} 条 / 代码 ${String(codeRoutes.size)} 条,已双向比对`,
);

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

const composeVars = new Set(
  [...read('docker-compose.yml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
);

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
notes.push(
  `环境变量:代码读 ${String(codeVars.size)} 个 / .env.example 声明 ${String(envExample.size)} 个,已双向比对`,
);

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
const changelogVersions = [
  ...designText.matchAll(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*(v[\d.]+)\s*\|/gm),
].map((m) => m[1]);
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
  return withoutQuery.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
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
    fail('前端调了不存在的路由:' + item + '(后端没有这条 —— 点了会是 404,而静态检查不会报)');
  }
  notes.push('前端调用:检查 ' + String(callCount) + ' 处,未匹配 ' + String(missing.length) + ' 处');
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
    notes.push(`生成块:接口/数据模型/环境变量/前端路由四张表已与代码比对`);
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
// 4.95) 章节引用必须指得到真章节(v4.0 新增)
// ============================================================

/*
  ⚠️ 这一条是被**旧文档的真实缺陷**逼出来的。

  旧版 DESIGN.md 把「§5.6」引用了 8 次(保密能力散落在 §1.2 / §5.2 / §5.3 /
  §6.1 / §6.3 / §9.6 各处),而 **§5.6 那一节根本不存在** —— 文档只写到 §5.3。
  源码注释里也引用了它(permission.ts、visibility.ts、search.service.ts、
  VisibilityDialog.tsx 等十余处)。

  这种漂移**检查不出来**是因为它两头都在"看起来正常"的范围内:
  文档读起来有节号,代码注释读起来有出处,而**没有任何一处会去核对那个号存不存在**。
  于是"保密能力"这件事在全仓库里没有一段集中的说明,只能在别处的只言片语里拼 ——
  而那正是用户说的「文档和实际功能仅仅是部分对齐」。

  所以这条检查同时对**文档自己**与**全部源码注释**核对:
  每一个 `§x.y` 都必须能在文档的标题里找到。加一节、删一节、重排节号,
  都会立刻在这里报出来,而不是等某天有人按着节号去翻却发现翻不到。
*/

/**
 * 文档里所有标题的编号。`## 5. 权限模型` → "5";`### 5.6 保密…` → "5.6"。
 */
const headingNumbers = new Set(
  [...designText.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)/gm)].map((m) => m[1]),
);

{
  const dangling = [];

  const checkRefs = (label, text, lineOf) => {
    text.split(/\r?\n/).forEach((line, index) => {
      for (const m of line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
        if (headingNumbers.has(m[1])) continue;
        dangling.push(`${label}${lineOf(index + 1)} 引用了 §${m[1]},但文档里没有这一节`);
      }
    });
  };

  checkRefs('DESIGN.md:', designText, (n) => `:${String(n)}`);

  let scanned = 0;
  for (const root of FORBIDDEN_SCAN_ROOTS) {
    for (const file of walkSource(path.join(ROOT, root), [])) {
      scanned += 1;
      const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        for (const m of line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
          if (headingNumbers.has(m[1])) continue;
          dangling.push(`${rel} 引用了 §${m[1]},但文档里没有这一节`);
        }
      }
    }
  }

  for (const item of dangling) {
    fail(`章节引用漂移:${item}; 要么补上那一节,要么把引用改成真实存在的节号`);
  }
  notes.push(
    `章节引用:文档 ${String(headingNumbers.size)} 个标题 / 扫描 ${String(scanned)} 个源文件,` +
      `悬空引用 ${String(dangling.length)} 处`,
  );
}

// ============================================================
// 10) 仓库里只允许有一篇 Markdown 文档(v4.5 新增)
// ============================================================

/*
  §0.3 的约定是「全仓库只留一篇文档」。但这条约定**原来没有任何机制**:
  这个脚本里是 `read('DESIGN.md')` 硬编码,没有任何地方枚举过 `*.md`。
  也就是说,把 `DEPLOY.md` / `README.md` 加回来,门禁**照样全绿** ——
  而"同一件事散在两三篇里、各自漂移"正是这份文档当初烂掉的起点。

  排除目录与 `.prettierignore` 保持一致:那些是依赖、构建产物与
  Prisma 生成/迁移目录,不是"人写的文档"的所在位置。
*/
{
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    'prototype',
    'generated',
    'migrations',
  ]);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.md$/i.test(entry.name)) {
        found.push(path.relative(ROOT, path.join(dir, entry.name)).replaceAll(path.sep, '/'));
      }
    }
  };
  walk(ROOT);

  /**
   * §0.3 的**显式例外**。
   *
   * ⚠️ 每一条都必须写清理由 —— 没有理由的名单迟早会变成"把报错塞进去就完事"
   * 的地方,那时这条检查就死了(与 HISTORICAL / ENV_READ_ELSEWHERE 同一条纪律)。
   *
   * 注意:"默认不允许"这条规则没有变。新增第二篇文档依然会让门禁变红,
   * 除非同时在这里登记理由 —— 那正是想要的效果。
   */
  const EXTRA_DOCS = new Map([
    [
      'REMAINING.md',
      '临时的工作交接清单(还剩什么没做),不是设计文档,做完即删;' +
        '破例放进仓库是因为开发机是网吧机器 —— 桌面与临时目录会被还原,放在仓库外第二天就没了。',
    ],
  ]);

  for (const file of found) {
    if (file === 'DESIGN.md' || EXTRA_DOCS.has(file)) continue;
    fail(
      `文档漂移:仓库里多了一篇 Markdown「${file}」—— §0.3 约定全仓库只留 DESIGN.md 一篇;` +
        ' 真要保留它,就得先在 scripts/audit-docs.mjs 的 EXTRA_DOCS 里显式登记理由,' +
        ' 并同步 DESIGN.md §0.3',
    );
  }
  const extras = found.filter((file) => file !== 'DESIGN.md');
  notes.push(
    `文档数量:仓库 Markdown 共 ${String(found.length)} 篇` +
      `(约定只有 DESIGN.md 一篇;显式例外 ${String(extras.length)} 篇` +
      `${extras.length === 0 ? '' : ':' + extras.join('、')})`,
  );
}

// ============================================================
// 11) 界面字号只允许用刻度档位(v4.5 新增 —— 补回被删掉的那条测试)
// ============================================================

/*
  `apps/web/src/lib/typography.ts` 文件末尾的"唯一规则"是:
  **组件代码里不允许写任意值字号**(`text-[13px]` 之类)。

  ⚠️ **执行范围要说清楚**(这是被一次对抗性复核逼出来的):下面只扫
  `.ts/.tsx/.mjs/.js`(`walkSource` 的过滤条件),**不扫 CSS**。
  所以准确的表述是「组件代码里的字号必须走四档刻度」,而不是
  「全仓库任何地方都不许出现任意值字号」—— `styles.css` 里本来就有
  若干相对字号(`1.65rem` / `0.9em` / 打印用的 `11pt` …),它们负责的是
  正文排版的相对刻度,与"组件里挑哪一档"是两件事。
  规则原文已按这个口径改写,免得读的人以为 CSS 也被管着。

  ⚠️ 这条规则原来由**测试**执行。那次"删除全部测试"把测试删掉之后,
  规则还留在文档与注释里,而**已经没有任何东西在执行它** ——
  `MIN_FONT_PX` / `ALLOWED_ARBITRARY_PX` 两个导出因此变成没人读的死常量。
  这比"没有规则"更坏:文档说有门禁,而门禁其实不存在。

  这里把它搬回**每次都会跑**的地方(与上面"弃用结构"同一条思路),
  而且阈值仍然从 `typography.ts` 里读 —— 那两个常量就此不再是死代码。
*/
{
  const typographySrc = read('apps/web/src/lib/typography.ts');
  const minFontPx = Number(/export const MIN_FONT_PX = (\d+)/.exec(typographySrc)?.[1]);
  const allowedRaw = /export const ALLOWED_ARBITRARY_PX = \[([^\]]*)\]/.exec(typographySrc)?.[1];
  const allowedArbitraryPx = [...(allowedRaw ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((m) =>
    Number(m[0]),
  );

  if (!Number.isFinite(minFontPx) || allowedRaw === undefined) {
    fail('字号刻度:读不到 typography.ts 的 MIN_FONT_PX / ALLOWED_ARBITRARY_PX —— 常量被改名了?');
  } else {
    /** 只有"看起来是长度"的值才算字号:`text-[#fff]` 是**文字颜色**,不能误伤。 */
    const ARBITRARY = /text-\[([^\]]+)\]/g;
    /**
     * ⚠️ 单位必须**忽略大小写**:CSS 的单位是不区分大小写的,
     * 而这条正则是大小写敏感的 —— 写 `text-[13PX]` 就能从检查底下走过去
     * (对抗性复核实测:门禁报"发现任意值字号 0 处")。
     */
    const LENGTH = /^(?:length:|font-size:)?\s*(\d+(?:\.\d+)?)(px|rem|em)$/i;

    let scanned = 0;
    let hits = 0;
    for (const file of walkSource(path.join(ROOT, 'apps/web/src'), [])) {
      scanned += 1;
      const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (line.includes('audit-docs:allow')) return;
          for (const m of line.matchAll(ARBITRARY)) {
            const value = m[1].trim();
            const length = LENGTH.exec(value);
            if (length === null) continue; // 颜色等非长度值,与字号无关
            hits += 1;
            const where = `${rel}:${String(index + 1)}`;
            // 单位要比小写再判:正则有 `i` 标志,`13PX` 必须算 px 而不是"非像素单位"
            if (length[2].toLowerCase() !== 'px') {
              fail(
                `字号刻度:${where} 用了 \`text-[${value}]\` —— 只能用像素刻度档位` +
                  '(T_BODY / T_NAV / T_LABEL / T_META),不要引入 rem/em 任意值',
              );
            } else if (Number(length[1]) < minFontPx) {
              fail(
                `字号刻度:${where} 的 \`text-[${value}]\` 小于屏上最小字号 ${String(minFontPx)}px`,
              );
            } else if (!allowedArbitraryPx.includes(Number(length[1]))) {
              fail(
                `字号刻度:${where} 用了任意值字号 \`text-[${value}]\` —— ` +
                  '四档刻度已经覆盖所有场景,想加新档先问它在 ADS 刻度里对应哪一个',
              );
            }
          }
        });
    }
    notes.push(
      `字号刻度:扫描 ${String(scanned)} 个前端源文件,发现任意值字号 ${String(hits)} 处` +
        `(最小 ${String(minFontPx)}px,白名单 ${String(allowedArbitraryPx.length)} 项)`,
    );
  }
}

// ============================================================
// 12) §9.1 的环境变量表必须覆盖代码真读的每个键(v4.7 新增)
// ============================================================

/*
  ⚠️ 这一条是**对抗性复核挖出来的**:第 8 项只比对"生成器的输出 ↔ 文档里的表",
  而生成器 `extractEnv` **每行只取第一个 `process.env.X`**(见 `gen-doc.mjs`)。
  于是 `toInt(process.env.API_PORT ?? process.env.PORT, 3000)` 这一行里,
  `PORT` **永远不会成为表里的一行** —— 而两份"计数"各自自洽:
    · 第 8 项比的是 生成物(14) ↔ 文档(14) ✓
    · 第 2 项比的是 代码扫描 ↔ `.env.example`,而 `PORT` 被 `ENV_EXTERNAL` 豁免 ✓
  **没有任何一项把这两个数放在一起看。** 今天无害(`PORT` 以别名形式出现在
  `API_PORT` 那一行的默认值表达式里,读者看得见),但下一个"与别的变量写在同一行"
  的新变量会**静默地不进文档**,而门禁全绿。

  所以这里补上交叉核对:代码读的每个键,要么**自己有一行**,
  要么**在某一行的默认值表达式里被真正引用**(`process.env.X` ——
  合法且常见,例如 `PORT` 就出现在 `API_PORT` 那一行)。
  两条都不满足才算漂移 —— 判据是"读者在 §9.1 里究竟查不查得到它"。

  ⚠️ 判据必须是"真的引用了 `process.env.X`",不能只是"这个词出现过":
  生成器把源码行的**整段尾巴(含行尾注释)**放进单元格,用 `\bNAME\b` 的话
  一句注释就能让缺失的行蒙混过关(对抗性复核实测)。
*/
{
  const envBegin = '<!-- BEGIN GENERATED:env -->';
  const envEnd = '<!-- END GENERATED:env -->';
  const envStart = designText.indexOf(envBegin);
  const envStop = designText.indexOf(envEnd, envStart + envBegin.length);
  if (envStart < 0 || envStop < 0) {
    fail('环境变量表:DESIGN.md 里找不到 `GENERATED:env` 生成块');
  } else {
    const block = designText.slice(envStart, envStop);
    const tableKeys = new Set();
    let exprText = '';
    for (const line of block.split('\n')) {
      /*
        ⚠️ 第二格用**宽松**匹配(`.*`),不能要求"里面没有反引号"。

        生成器把一个 `tsconfig`/模板串之类的默认值原样放进单元格时,格子里
        会出现内层反引号(`| `UPLOAD_DIR` | `process.env.UPLOAD_DIR ?? `/data/uploads`` |`)——
        那是**格式上有点毛边的 Markdown,但行确实在表里**。原来那条严格正则
        (`([^`]*)`)匹配不到它,于是门禁报"读者查不到它":**行明明在,却判成缺失**。
        对抗性复核实测到了这一条。
      */
      const m = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|(.*)\|\s*$/.exec(line);
      if (m === null) continue;
      tableKeys.add(m[1]);
      exprText += ' ' + m[2];
    }

    const uncovered = [];
    for (const name of codeVars) {
      if (ENV_EXTERNAL.has(name) || ENV_READ_ELSEWHERE.has(name)) continue;
      if (tableKeys.has(name)) continue;
      /*
        ⚠️ 必须是**真的引用了这个变量**(`process.env.NAME`),不能只是"这个词
        在某个格子里出现过"。

        原来的判据是 `\bNAME\b`,而生成器把源码里那一行的**整段尾巴**都放进
        单元格 —— **包括行尾注释**。于是只要在任意一行的注释里提一句
        "与 REDIS_URL 一样",那个变量的行就算"被覆盖"了:
        实测把它自己的行从文档里删掉,门禁仍然 exit 0 并打印"未覆盖的代码键 0 个"。
        一个能被注释满足的覆盖判据,等于没有判据。
      */
      const referenced = new RegExp(
        'process\\.env\\.' + name + '\\b' + '|' + 'process\\.env\\[[\'"]' + name + '[\'"]\\]',
      );
      if (referenced.test(exprText)) continue;
      uncovered.push(name);
    }
    for (const name of uncovered) {
      fail(
        '环境变量表:代码读 `' +
          name +
          '`,但 §9.1 里既没有它自己的行、' +
          '也没有在任一行的默认值表达式里被真正引用(`process.env.' +
          name +
          '`)—— 读者查不到它',
      );
    }
    notes.push(
      '环境变量表:表内 ' +
        String(tableKeys.size) +
        ' 行,未覆盖的代码键 ' +
        String(uncovered.length) +
        ' 个',
    );
  }
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
