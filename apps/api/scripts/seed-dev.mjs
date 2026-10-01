/**
 * 开发 / 验收用种子数据(v2.0 组织架构模型)。
 *
 * 用法(**必须先清库**,它不做幂等):
 *   docker compose down -v && docker compose up -d
 *   pnpm seed:dev
 *
 * ⚠️ 它会**走真实的 Excel 导入接口**来建组织与人员,而不是直接写库。
 * 两个好处:
 *   1. 导入功能顺带被端到端验一遍(出问题时种子会直接失败,而不是等到用户点);
 *   2. 造出来的数据一定符合"系统能表达的形状",不会出现库里能存、
 *      界面表达不了的状态。
 *
 * ⚠️ 三件要知道的事:
 *   - **KC003 / KC004 的密码仍是 `123456`**(见生成的 `DEMO-ACCOUNTS.txt`)——
 *     登录后会被强制改密,这正是新账号的真实流程,拿来验收最合适。
 *   - **KC002(陈默)与 KC005(孙浩)的密码被改成种子密码**:他们要在种子里
 *     创建内容,而"未改密的人没有任何登录态"会让所有业务接口回 401。
 *     这两人顺带把"首登改密 → 改完必须重新登录"这条链路真验一遍 ——
 *     **KC002 走内联那一段**(中间还要插一条"没有登录态就回 401"的断言),
 *     **KC005 走 `loginAs`**;两处的断言是同一组。
 *   - 列顺序必须与 `apps/api/src/org/import.core.ts` 的 `IMPORT_COLUMNS` 一致。
 *     这一点由**导入预览的断言**兜住(新建节点数 / 新建人数 / 预览错误必须为空):
 *     列顺序错了,解析出来的形状就与预期不符,脚本当场失败。
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';

const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
const ROOT = process.env.KC_ROOT ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD ?? 'Kc-admin-2026';

/**
 * 新账号的内置初始密码。
 *
 * ⚠️ 必须与 `packages/shared/src/org.ts` 的 `INITIAL_PASSWORD` 一致。
 * 这里**刻意不 import 那个常量**:引入 `@knowledgecool/shared` 会让本脚本
 * 依赖 `packages/shared/dist` 已经构建,而它现在只依赖 exceljs ——
 * 种子脚本要能在"刚 clone 完、还没 build"时也跑得起来。
 * (同样的取舍见 `reset-demo-passwords.mjs`,那边也是硬编码 + 这条注释。)
 */
const INITIAL_PASSWORD = '123456';

// 与 import.core.ts 的 IMPORT_COLUMNS 一一对应(顺序不能变)
const COLUMNS = ['工号', '姓名', '部门', '组 / 项目', '负责人', '部门ID(勿改)', '组ID(勿改)'];

/** 全员名单:一行 = 一个人在一个节点上的归属。 */
const ROSTER = [
  // 工号, 姓名, 部门, 组/项目, 是否负责人
  ['KC002', '陈默', '技术部', null, true],
  ['KC003', '王思远', '技术部', '后端组', true],
  ['KC004', '赵敏', '技术部', '后端组', false],
  ['KC003', '王思远', '技术部', 'CRM 项目', true],
  ['KC005', '孙浩', '市场部', null, true],
];

let cookie = '';

/**
 * 跟随响应里的 `Set-Cookie`。
 *
 * ⚠️ 值为空 = 服务端在**清**这个 Cookie(登出),必须跟着清 —— 否则旧的
 * 会话会一直留在变量里,后面所有请求都还在用上一个人的身份。
 */
function syncCookie(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const item of raw) {
    const match = /kc_session=([^;]*)/.exec(item);
    if (match === null) continue;
    cookie = match[1] === '' ? '' : `kc_session=${match[1]}`;
  }
}

async function api(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie !== '') headers.Cookie = cookie;
  if (body !== undefined && !options.formData) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  syncCookie(response);

  const text = await response.text();
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  // `setCookie` 要带出来:首登那道响应**不写 Cookie**,只看状态码分不出来。
  return {
    status: response.status,
    body: json,
    setCookie: response.headers.getSetCookie?.() ?? [],
  };
}

/**
 * 切换身份前必须清掉上一个人的会话。
 *
 * ⚠️ 它只清**本进程的这个变量**,不调 `POST /auth/logout` ——
 * 服务端那几行 `sessions` 会一直留到过期(完整跑一次大约 5 行:
 * 超管 1、陈默 2、孙浩 2)。对开发/演示库无害,但**别以为"跑完种子不会留下登录态"**。
 * 若想让它们当场消失,在这里补一次 best-effort 的
 * `await api('POST', '/auth/logout')` 即可 —— 注意 cookie 为空时那个接口回 401,
 * 必须忽略掉,不能让它把种子弄失败。
 */
function forgetSession() {
  cookie = '';
}

/**
 * 以某个账号登录,并**在需要时完成首次改密**。
 *
 * ⚠️ v2.4 起首次登录**不建立会话**:返回 `password-change-required` 与一张
 * 10 分钟的一次性凭证;改密之后**仍然不给会话**,必须用新密码再登一次。
 *
 * ⚠️⚠️ 这里每次都先 `forgetSession()`,原因是踩过的坑:
 * "首登不写 Cookie"意味着那句登录**不会覆盖**上一个人的会话,而本脚本原来
 * 共用一个全局 `cookie` —— 于是脚本以为自己在以陈默操作,请求却带着
 * KC001(超管)的会话。`verify-org.mjs` 里记过同一个坑,这边当时漏改了。
 */
async function loginAs(employeeNo, initialPassword, newPassword, label) {
  forgetSession();
  const first = await api('POST', '/auth/login', { employeeNo, password: initialPassword });
  if (first.status !== 200 || first.body?.kind !== 'password-change-required') {
    console.error(
      `✗ ${label} 首次登录未返回 password-change-required:`,
      JSON.stringify(first.body),
    );
    process.exit(1);
  }
  if (first.setCookie.some((item) => item.startsWith('kc_session='))) {
    console.error(`✗ ${label} 首次登录竟然下发了会话 Cookie —— 强制改密被绕过了`);
    process.exit(1);
  }
  console.log(`✓ ${label} 首次登录只拿到一次性凭证,未建立会话`);

  expectOk(
    `${label} 凭一次性凭证设置新密码`,
    await api('POST', '/auth/initial-password', {
      setupToken: first.body.setupToken,
      newPassword,
    }),
  );
  expectSessionEstablished(
    `${label} 用新密码重新登录(这次才建立会话)`,
    await api('POST', '/auth/login', { employeeNo, password: newPassword }),
  );
}

function expectOk(label, result) {
  if (result.status >= 200 && result.status < 300) {
    console.log(`✓ ${label}`);
    return result.body;
  }
  console.error(`✗ ${label} → HTTP ${String(result.status)}`);
  console.error(JSON.stringify(result.body, null, 2));
  process.exit(1);
}

/**
 * 断言"这一次登录**真的建立了会话**"。
 *
 * ⚠️ 只靠 `expectOk` 是不够的:它只要求 2xx,而**首登那条路径也是 2xx 且不发会话**。
 * 不复核 `kind` 与 Cookie 的话,一旦改密那一步静默失效(例如服务端仍认为这个人
 * 处于待改密状态),脚本就会带着**空 cookie** 继续往下跑,然后在某个毫不相关的
 * 请求上报 401 —— 报错位置离真正的原因隔了十几步,极难排查。
 */
function expectSessionEstablished(label, result) {
  if (
    result.status !== 200 ||
    result.body?.kind !== 'session' ||
    !result.setCookie.some((item) => item.startsWith('kc_session='))
  ) {
    console.error(
      `✗ ${label} 没有建立会话(期望 200 + kind=session + Set-Cookie):HTTP ${String(result.status)}`,
    );
    console.error(JSON.stringify(result.body, null, 2));
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

// ---------------------------------------------------------------- 文档构造

const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const para = (...content) => ({ type: 'paragraph', content });
const heading = (level, value) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const bullet = (...items) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [para(text(item))] })),
});
const code = (value) => ({ type: 'codeBlock', content: [text(value)] });

function table(rows) {
  return {
    type: 'table',
    content: rows.map((cells, index) => ({
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: index === 0 ? 'tableHeader' : 'tableCell',
        content: [para(text(cell))],
      })),
    })),
  };
}

const doc = (...content) => ({ type: 'doc', content });

const DOCS = {
  研发规范: doc(
    heading(1, '研发规范'),
    para(text('本文约定技术部的研发流程与提交规范,由部长维护,全员可读。')),
    heading(2, '一、分支模型'),
    bullet(
      'main 保持随时可发布:任何时刻从 main 拉出来的代码都能跑起来',
      '功能分支从 main 切出,合并前必须通过全部检查',
      '紧急修复走 hotfix 分支,修完同时回合 main',
    ),
    heading(2, '二、提交信息'),
    para(
      text(
        '提交信息用「类型: 说明」的格式,类型取值为 feat / fix / docs / refactor / test / chore。',
      ),
    ),
    code('feat: 支持按工号登录\nfix: 移动节点后子孙路径未重建'),
    heading(2, '三、代码评审'),
    para(text('所有改动必须经过至少一人评审。评审看三件事:正确性、可读性、有没有把复杂度藏起来。')),
  ),
  技术方案: doc(
    heading(1, '技术方案'),
    para(text('本页记录后端组当前的技术选型与演进方向。')),
    heading(2, '技术栈'),
    table([
      ['层', '选型', '为什么'],
      ['前端', 'React + Vite', '生态最全'],
      ['后端', 'Node + NestJS', '与前端同语言'],
      ['主库', 'PostgreSQL 16', '递归查询与中文检索一个库全解决'],
      ['缓存', 'Redis 7', '权限判定缓存'],
    ]),
    heading(2, '权限模型'),
    para(
      text('读默认对所有登录用户开放;'),
      text('编辑权', [{ type: 'bold' }]),
      text('由所有者、祖先链与显式授权三者共同决定。'),
    ),
    para(
      // ⚠️ 这里原本写的是「系统不提供保密能力」—— 那句在 v2.12 加了
      // visibility=restricted 之后就不成立了,而它是**演示数据里的正文**,
      // 也就是用户会读到的一句话。错的演示文案比错的注释更值得修。
      text('少数确有需要的节点可以设成「受限」,只有所有者、被授权编辑的人'),
      text('与指定名单能看;限制对整棵子树生效。'),
    ),
    heading(2, '待办'),
    bullet('节点规模上来后的检索迁移', '实时协同(阶段二)'),
  ),
  接口规范: doc(
    heading(1, '接口规范'),
    para(text('后端组内部 API 的约定。')),
    heading(2, '命名'),
    bullet('路径用复数资源名:/nodes、/comments', '错误体统一为 { error: { code, message } }'),
    heading(2, '错误码'),
    code(
      'UNAUTHORIZED        401 未登录\nFORBIDDEN           403 已登录但无权限\nNOT_FOUND           404 内容不存在',
    ),
  ),
  'CRM 项目概览': doc(
    heading(1, 'CRM 项目概览'),
    para(text('CRM 项目的目标与边界。')),
    heading(2, '目标'),
    para(text('把散落在个人表格里的客户信息收进来,统一口径。')),
    heading(2, '不做什么'),
    bullet('不做营销自动化', '不做呼叫中心'),
  ),
  市场部工作方式: doc(
    heading(1, '市场部工作方式'),
    para(text('市场部的对外口径与素材规范。')),
    para(text('按季度更新对外话术;所有对外材料需经部长确认。')),
  ),
};

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`接口: ${BASE}\n`);

  const setupState = await api('GET', '/auth/setup-state');
  if (setupState.body?.required === false) {
    console.error('✗ 库里已经有数据了。这个种子只适用于**全新数据库**,请先执行:');
    console.error('    docker compose down -v && docker compose up -d');
    process.exit(1);
  }

  // ---- 1. 初始化超级管理员 ----
  expectOk(
    '创建超级管理员 KC001 · 林晓',
    await api('POST', '/auth/setup', {
      employeeNo: 'KC001',
      name: '林晓',
      password: ADMIN_PASSWORD,
    }),
  );

  // ---- 2. 用 Excel 导入组织架构与人员 ----
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('人员名单');
  sheet.addRow(COLUMNS);
  for (const [employeeNo, name, department, group, isOwner] of ROSTER) {
    // 部门ID / 组ID 留空 = 让系统按名字匹配或新建(导入也支持这条路径,顺带验它)
    sheet.addRow([employeeNo, name, department, group ?? null, isOwner ? '是' : null, null, null]);
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const form = new FormData();
  form.append('file', new Blob([buffer]), 'roster.xlsx');

  const preview = expectOk(
    '上传名单并预览差异',
    await api('POST', '/admin/org/import?dryRun=true', undefined, { formData: form }),
  );

  const previewErrors = preview.preview.errors;
  if (previewErrors.length > 0) {
    console.error('✗ 导入预览报错,种子的表格或解析逻辑有问题:');
    for (const item of previewErrors) {
      console.error(`    第 ${item.row} 行:${item.reason}`);
    }
    process.exit(1);
  }
  const nodeCount = preview.preview.newNodes.length;
  if (nodeCount !== 4) {
    console.error(`✗ 预期新建 4 个节点(技术部/后端组/CRM 项目/市场部),实际 ${String(nodeCount)}:`);
    for (const item of preview.preview.newNodes) console.error(`    ${item.path}`);
    process.exit(1);
  }
  if (preview.preview.newUsers.length !== 4) {
    console.error(`✗ 预期新建 4 个人,实际 ${String(preview.preview.newUsers.length)}`);
    process.exit(1);
  }
  console.log(
    `  新增节点 ${String(nodeCount)} 个 / 人员 ${String(preview.preview.newUsers.length)} 人 / 归属 ${String(preview.preview.newAssignments.length)} 条`,
  );

  const form2 = new FormData();
  form2.append('file', new Blob([buffer]), 'roster.xlsx');
  expectOk(
    '确认导入',
    await api(
      'POST',
      `/admin/org/import?dryRun=false&contentHash=${preview.contentHash}`,
      undefined,
      { formData: form2 },
    ),
  );

  // ---- 3. 摸清树的形状 ----
  const tree = expectOk('读取组织树', await api('GET', '/org/tree'));
  const byTitle = (title) => tree.nodes.find((node) => node.title === title);
  const titles = tree.nodes.map((node) => node.title).join('、');
  console.log(`  节点:${titles}`);

  for (const required of ['技术部', '后端组', 'CRM 项目', '市场部']) {
    if (byTitle(required) === undefined) {
      console.error(`✗ 树里找不到「${required}」`);
      process.exit(1);
    }
  }

  // ---- 3.5 趁**超管会话还在**,先把赵敏(KC004)的 id 取出来 ----
  //
  // ⚠️ 这一步的位置是**必须的**,不能挪到后面去:
  // `GET /admin/users` 是**超管专属**(`org.controller.ts` 的「人员列表。超管专属」与
  // `OrgService.listUsers` 里的 `requireSuperAdmin`)—— 名册含账号状态与登录时间,
  // 不是公开信息(仓库自己的验收里也钉着这一条:非超管读名册必须 403)。
  //
  // 而第 7 步给赵敏授权是用**陈默(KC002,非超管)**的身份做的 ——
  // 走到那里已经没有哪个身份能读名册了。
  //
  // 旧版把这次查询放在授权之前,而当时手里恰好是**超管的残留会话**,
  // 于是"非超管读名册"这件事被掩盖了;把 cookie 的坑修掉之后它才浮出来。
  // (返回体是 `{ users, total, nextCursor }` 而不是数组 —— 游标分页包装,
  //  见 `packages/shared/src/org.ts` 的 `OrgUserListResponse`。)
  const roster = expectOk('读取人员列表(超管专属)', await api('GET', '/admin/users?limit=500'));
  // ⚠️ 先确认"这一页就是全部"。`limit=500` 已经是接口上限,人再多就会分页,
  // 而赵敏可能落在第二页 —— 那时下面会报"找不到 KC004 赵敏",把人引向
  // "人没建出来"这个错误方向(她其实在,只是不在这页)。这一版种子假设演示组织只有 5 人。
  if (roster.total > roster.users.length) {
    console.error(
      `✗ 人员列表被分页了(${String(roster.users.length)}/${String(roster.total)}),` +
        'KC004 可能不在这一页 —— 本脚本假设演示组织只有 5 个人',
    );
    process.exit(1);
  }
  const zhao = roster.users.find((user) => user.employeeNo === 'KC004');
  if (zhao === undefined) {
    console.error('✗ 人员列表里找不到 KC004 赵敏');
    process.exit(1);
  }

  // ---- 4. 陈默(技术部部长)登场:他要先改密才能做任何事 ----
  console.log('\n—— 以陈默(技术部部长)的身份创建内容 ——');
  forgetSession();
  const chenFirst = await api('POST', '/auth/login', {
    employeeNo: 'KC002',
    password: INITIAL_PASSWORD,
  });
  if (chenFirst.status !== 200 || chenFirst.body?.kind !== 'password-change-required') {
    console.error(
      '✗ 陈默(KC002)首次登录未返回 password-change-required:',
      JSON.stringify(chenFirst.body),
    );
    process.exit(1);
  }
  if (chenFirst.setCookie.some((item) => item.startsWith('kc_session='))) {
    console.error('✗ 首次登录竟然下发了会话 Cookie —— 强制改密被绕过了');
    process.exit(1);
  }
  console.log('✓ KC002 用初始密码 123456 登录 → 只拿到一次性凭证,未建立会话');

  // 顺带验一条产品行为:**改密之前他没有任何登录态**,所以业务接口回 401 而不是 403。
  // (v2.4 之前是"先发会话、再由守卫拦成 403 PASSWORD_CHANGE_REQUIRED";
  //  那条路径没了之后,`PASSWORD_CHANGE_REQUIRED` 这个错误码再也没有生产者,
  //  已从 shared 的错误码表里删除。)
  const blocked = await api('GET', '/org/tree');
  if (blocked.status !== 401 || blocked.body?.error?.code !== 'UNAUTHORIZED') {
    console.error('✗ 未登录访问业务接口没有被拦成 401:', JSON.stringify(blocked.body));
    process.exit(1);
  }
  console.log('✓ 改密之前业务接口回 401(不是 403)');

  expectOk(
    'KC002 凭一次性凭证设置新密码',
    await api('POST', '/auth/initial-password', {
      setupToken: chenFirst.body.setupToken,
      newPassword: PASSWORD,
    }),
  );
  expectSessionEstablished(
    'KC002 用新密码重新登录(这次才建立会话)',
    await api('POST', '/auth/login', { employeeNo: 'KC002', password: PASSWORD }),
  );

  // ---- 5. 建内容 ----
  const created = new Map();

  async function createDoc(title, parentTitle) {
    const parent = parentTitle === null ? null : byTitle(parentTitle);
    if (parentTitle !== null && parent === undefined) {
      console.error(`✗ 找不到父节点「${parentTitle}」`);
      process.exit(1);
    }
    const node = expectOk(
      `新建「${title}」${parentTitle === null ? '(顶层)' : ` 于「${parentTitle}」下`}`,
      await api('POST', '/nodes', {
        parentId: parent?.id ?? null,
        kind: 'document',
        title,
      }),
    );
    created.set(title, node.id);
    const saved = await api('PUT', `/nodes/${node.id}/content`, {
      content: DOCS[title],
      baseUpdatedAt: new Date(0).toISOString(),
    });
    if (saved.status !== 200) {
      console.error(`✗ 保存「${title}」的正文失败:HTTP ${String(saved.status)}`);
      console.error(JSON.stringify(saved.body, null, 2));
      process.exit(1);
    }
    return node;
  }

  await createDoc('研发规范', '技术部');
  await createDoc('技术方案', '技术部');
  await createDoc('接口规范', '后端组');
  await createDoc('CRM 项目概览', 'CRM 项目');

  // 市场部的页面由孙浩自己建(他不是超管,但他是市场部所有者)
  console.log('\n—— 以孙浩(市场部部长)的身份创建内容 ——');
  await loginAs('KC005', INITIAL_PASSWORD, PASSWORD, '孙浩(KC005)');
  await createDoc('市场部工作方式', '市场部');

  // ---- 6. 评论(全体都能发;陈默发一条并回复一条) ----
  console.log('\n—— 评论 ——');
  const marketComment = await api('POST', `/nodes/${created.get('市场部工作方式')}/comments`, {
    body: '这份口径我按季度维护,有异议直接在这里说。',
  });
  expectOk('孙浩在市场部页面留言', marketComment);

  forgetSession();
  expectSessionEstablished(
    'KC002 登录',
    await api('POST', '/auth/login', { employeeNo: 'KC002', password: PASSWORD }),
  );
  const techComment = expectOk(
    '陈默在「技术方案」留言',
    await api('POST', `/nodes/${created.get('技术方案')}/comments`, {
      body: '数据库版本定在 16,不要用 15 的语法。',
    }),
  );
  expectOk(
    '陈默回复自己的留言',
    await api('POST', `/nodes/${created.get('技术方案')}/comments`, {
      body: '补充:升级前先跑一遍备份恢复演练。',
      parentId: techComment.id,
    }),
  );

  // ---- 7. 给赵敏一条额外授权,用来验收"被授权者能改但不能转授" ----
  const grants = expectOk(
    '读取「接口规范」的授权视图',
    await api('GET', `/nodes/${created.get('接口规范')}/grants`),
  );
  // 赵敏的 id 在第 3.5 步(超管阶段)就取好了 —— 名册是超管专属,这里读不到。
  const grantResult = await api('PUT', `/nodes/${created.get('接口规范')}/grants`, {
    version: grants.version,
    userIds: [zhao.id],
  });
  if (grantResult.status !== 200) {
    console.error(`✗ 给赵敏授权失败:HTTP ${String(grantResult.status)}`);
    console.error(JSON.stringify(grantResult.body, null, 2));
    process.exit(1);
  }
  console.log('✓ 把「接口规范」的编辑权额外授予赵敏');

  // ---- 8. 记一份账号清单 ----
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', '..', '..', 'DEMO-ACCOUNTS.txt');
  const lines = [
    '知源 KnowledgeCool · 演示账号',
    `生成时间: ${new Date().toISOString()}`,
    '',
    `访问入口: ${ROOT}`,
    '',
    '组织架构:',
    '  技术部(部长 陈默)',
    '    ├─ 后端组(组长 王思远)',
    '    └─ CRM 项目(组长 王思远)',
    '  市场部(部长 孙浩)',
    '',
    '工号    姓名    角色                          密码             首登要改密',
    '─────  ─────  ────────────────────────────  ───────────────  ──────────',
    `KC001  林晓    超级管理员                    ${ADMIN_PASSWORD.padEnd(15)}  否`,
    `KC002  陈默    技术部部长                    ${PASSWORD.padEnd(15)}  否`,
    `KC003  王思远  后端组组长 + CRM 项目组长     ${INITIAL_PASSWORD.padEnd(15)}  是 ←`,
    `KC004  赵敏    技术部 / 后端组 组员          ${INITIAL_PASSWORD.padEnd(15)}  是 ←`,
    `KC005  孙浩    市场部部长                    ${PASSWORD.padEnd(15)}  否`,
    '',
    `⚠️ KC003 / KC004 的初始密码是 ${INITIAL_PASSWORD}。用它登录**不会直接进入系统** ——`,
    '   而是跳到「设置你的密码」页;设完回登录页,**再用新密码登录一次**才进得去。',
    '   (首次登录不记录登录状态,这是刻意的,不是故障。)改完请记住你自己设的那个。',
    '',
    '⚠️ 跑验收脚本**不会**再改坏这两个密码(v2.6 起)。',
    '   verify-org 里那段"验证首次登录强制改密"的断言会真的改密码,但脚本最后一组',
    '   会用超管的「重置密码」把 KC003 / KC004 放回上表的状态 —— 所以它是幂等的。',
    '   万一脚本中途抛异常没跑到那一组,两条路任选:',
    '       a) 界面上:用 KC001 登录 → 人员 → 对 KC003 / KC004 点「重置密码」',
    '       b) 命令行:docker compose exec api node scripts/reset-demo-passwords.mjs',
    '',
    '⚠️ 同事忘了密码,用「人员 → 重置密码」(超管)。它会踢他下线,别在他写文档时做。',
    '',
    '验收流程:先跑本脚本,再跑 pnpm verify:org(168 项端到端)。',
    '',
    '⚠️ 这是**演示数据**,口令明文写在这个文件里。',
    '   验完请换成自己的数据,并把演示账号停用(人员管理 → 状态改成「已停用」)。',
    '',
  ];
  if (existsSync(outPath)) {
    console.log(`(覆盖已存在的 ${outPath})`);
  }
  writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`\n✅ 种子完成。账号清单已写入 DEMO-ACCOUNTS.txt`);
  console.log(`   演示密码:${PASSWORD}  管理员密码:${ADMIN_PASSWORD}`);
}

await main();
