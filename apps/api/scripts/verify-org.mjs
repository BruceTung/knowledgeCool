/**
 * v2.0 权限模型的端到端验收(DESIGN.md §9.2 引用的就是这个脚本)。
 *
 * 用法(先 `pnpm seed:dev`):
 *   pnpm verify:org
 *   # 指向别的实例:
 *   KC_API=http://host:8080/api/v1 KC_ROOT=http://host:8080 \
 *   KC_SEED_PASSWORD=xxx KC_ADMIN_PASSWORD=yyy node apps/api/scripts/verify-org.mjs
 *
 *   # 在 api 容器里跑(静态直出那一项要指到 web 容器):
 *   docker compose exec -e KC_API=http://127.0.0.1:3000/api/v1 \
 *     -e KC_ROOT=http://web api node scripts/verify-org.mjs
 *
 * ⚠️ **它有副作用:会把演示账号的密码改掉。**
 *
 * A 组那段「验证首次登录强制改密」不是演给你看的 —— 它**真的**会把 KC003 的密码
 * 从 `123456` 改成 `KC_SEED_PASSWORD`;而 `login()` 这个辅助函数在发现
 * `mustChangePassword` 为真时也会顺手改密,所以 KC004 同样会被改。
 *
 * 后果:**跑完之后 `DEMO-ACCOUNTS.txt` 里写的 `123456` 就登不上了。**
 * 这不是 bug —— 要验就真验,不能只看界面。想还原成文档描述的状态:
 *
 *   docker compose exec api node scripts/reset-demo-passwords.mjs
 *
 * (每次跑都会少 7 项断言:那两个账号已经改过密了,强制改密那一段会走"跳过"分支。
 *  所以「122 项通过」等于「129 项通过」,不是回归。)
 *
 * ⚠️ 与上一版脚本的**根本区别**:v1 的 76 项断言里有一批在新模型下是错的反的
 * (「只读成员越权 403」「检索结果按权限过滤」)—— 那些断言的存在本身就说明
 * 模型理解错了。这一版按新模型重写,重点验四件新事情:
 *
 *   1. **读全员开放** —— 别部门的人也能读(旧断言与之相反)
 *   2. **越靠上权限越大** —— 部长能改本部门的一切;组员只能改自己的
 *   3. **组的边界是真的** —— 后端组的组员不能在 CRM 项目下新建
 *   4. **授权受组织范围约束** —— 部长不能把权限给到别的部门的人
 *
 * v2.4 追加两组:
 *   L. **节点成员(组织归属)** —— 谁在哪个节点下、能不能移出;调岗两步;
 *      以及"读全员开放、写要 canManage"这条在该接口上是否成立。
 *   M. **回收站保留策略 + 树的按根查询** —— 保留期内的东西不会被清掉;
 *      子树查询里祖先链仍然参与判权(最容易做错的一处,错了不报任何错)。
 */

const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
const ROOT = process.env.KC_ROOT ?? 'http://127.0.0.1:8080';
const SEED_PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD ?? 'Kc-admin-2026';
const INITIAL_PASSWORD = '123456';

let passed = 0;
let failed = 0;

function check(label, ok, extra) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra === undefined ? '' : `   → ${extra}`}`);
  }
}

// ---------------------------------------------------------------- HTTP

let cookie = '';

function syncCookie(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const item of raw) {
    const match = /kc_session=([^;]*)/.exec(item);
    if (match?.[1] !== undefined) cookie = `kc_session=${match[1]}`;
  }
}

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (cookie !== '') headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  syncCookie(response);

  const text = await response.text();
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
}

/**
 * 登录。
 *
 * 初始密码 `123456` 的账号会被强制改密,所以这里**顺便把改密流程也验了**:
 * 用 123456 登进去之后立刻改成目标密码。这样脚本第一遍跑也只需 seed 一次。
 */
async function login(employeeNo, candidates) {
  for (const password of candidates) {
    const attempt = await api('POST', '/auth/login', { employeeNo, password });
    if (attempt.status === 200 || attempt.status === 201) {
      const me = await api('GET', '/auth/me');
      if (me.body?.user?.mustChangePassword === true) {
        const changed = await api('POST', '/auth/change-password', {
          currentPassword: password,
          newPassword: SEED_PASSWORD,
        });
        if (changed.status !== 204) {
          throw new Error(
            `${employeeNo} 改密失败:HTTP ${String(changed.status)} ${JSON.stringify(changed.body)}`,
          );
        }
        console.log(`  · ${employeeNo} 用初始密码登录 → 已被强制改密(顺带验过这条链路)`);
      }
      return true;
    }
  }
  return false;
}

async function whoami() {
  const me = await api('GET', '/auth/me');
  return me.body?.user ?? null;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`接口: ${BASE}\n`);

  // ============================================================
  // A. 认证与强制改密
  // ============================================================
  console.log('A. 认证与强制改密');

  cookie = '';
  check('未登录访问 /org/tree → 401', (await api('GET', '/org/tree')).status === 401);

  const wrongPassword = await api('POST', '/auth/login', {
    employeeNo: 'KC002',
    password: 'definitely-wrong',
  });
  const unknownUser = await api('POST', '/auth/login', {
    employeeNo: 'KC999',
    password: 'definitely-wrong',
  });
  check('密码错误 → 401', wrongPassword.status === 401);
  check('工号不存在 → 401', unknownUser.status === 401);
  // 两者形状必须**完全一致**,否则可以靠错误信息枚举出哪些工号是真的
  check(
    '两种失败的错误体完全一致(不泄露账号是否存在)',
    JSON.stringify(wrongPassword.body) === JSON.stringify(unknownUser.body),
    `${JSON.stringify(wrongPassword.body)} vs ${JSON.stringify(unknownUser.body)}`,
  );

  // 未改密的账号:me 要能读,别的接口要被挡
  cookie = '';
  const loginKc003 = await api('POST', '/auth/login', {
    employeeNo: 'KC003',
    password: INITIAL_PASSWORD,
  });
  if (loginKc003.status !== 200 && loginKc003.status !== 201) {
    console.log('  · KC003 的密码已经不是初始密码了(脚本已跑过一次),跳过强制改密的断言');
  } else {
    const meDuringGate = await api('GET', '/auth/me');
    check(
      '未改密时 /auth/me 仍可读(前端要靠它知道该跳改密页)',
      meDuringGate.status === 200 && meDuringGate.body.user.mustChangePassword === true,
    );
    const blocked = await api('GET', '/org/tree');
    check(
      '未改密时其他接口 → 403 PASSWORD_CHANGE_REQUIRED',
      blocked.status === 403 && blocked.body?.error?.code === 'PASSWORD_CHANGE_REQUIRED',
    );
    const changed = await api('POST', '/auth/change-password', {
      currentPassword: INITIAL_PASSWORD,
      newPassword: 'abc',
    });
    check('新密码太弱(少于 8 位)→ 400', changed.status === 400);
    const changed2 = await api('POST', '/auth/change-password', {
      currentPassword: INITIAL_PASSWORD,
      newPassword: '12345678',
    });
    check('新密码只有数字 → 400', changed2.status === 400);
    const changed3 = await api('POST', '/auth/change-password', {
      currentPassword: 'wrong-current',
      newPassword: 'Abcd1234',
    });
    check('当前密码不对 → 401', changed3.status === 401);
    const ok = await api('POST', '/auth/change-password', {
      currentPassword: INITIAL_PASSWORD,
      newPassword: SEED_PASSWORD,
    });
    check('改成合法密码 → 204', ok.status === 204);
    check('改密后 /org/tree 可访问', (await api('GET', '/org/tree')).status === 200);
  }

  // ============================================================
  // 摸清树与人的位置(用超管)
  // ============================================================
  cookie = '';
  if (!(await login('KC001', [ADMIN_PASSWORD]))) {
    console.error('✗ 超管 KC001 登录失败 —— 先跑 pnpm seed:dev');
    process.exit(1);
  }
  const admin = await whoami();
  check('超管 KC001 登录成功且 isSuperAdmin 为真', admin?.isSuperAdmin === true);

  const tree = (await api('GET', '/org/tree')).body;
  const nodeId = (title) => tree.nodes.find((node) => node.title === title)?.id;
  const users = (await api('GET', '/admin/users')).body;
  const userId = (employeeNo) => users.find((user) => user.employeeNo === employeeNo)?.id;

  for (const title of ['技术部', '市场部', '后端组', 'CRM 项目', '研发规范', '技术方案', '接口规范', '市场部工作方式']) {
    if (nodeId(title) === undefined) {
      console.error(`✗ 树里找不到「${title}」—— 先跑 pnpm seed:dev`);
      process.exit(1);
    }
  }
  console.log(`  · 树:${tree.nodes.map((n) => n.title).join('、')}`);

  const adminEditable = new Set(tree.editableNodeIds);
  check(
    '超管不是内容的自动所有者(组织权限与内容权限是分开的)',
    !adminEditable.has(nodeId('研发规范')),
  );
  // 超管**不在** `manageableNodeIds` 里 —— 他不是任何节点的所有者。
  // 但一级部门换部长只有他能做,所以那条路径由「候选人 + 任命」这对接口承载,
  // 单独验(界面上的齿轮按钮也是据此对超管开放的)。
  const adminOwnerCandidates = await api('GET', `/nodes/${nodeId('技术部')}/owner-candidates`);
  check(
    '超管能拿到一级部门的所有者候选人(界面上「换部长」依赖它)',
    adminOwnerCandidates.status === 200 && adminOwnerCandidates.body.length > 0,
    `HTTP ${String(adminOwnerCandidates.status)} ${JSON.stringify(adminOwnerCandidates.body).slice(0, 80)}`,
  );

  // ============================================================
  // B. 读:全员开放
  // ============================================================
  console.log('\nB. 读对所有登录用户开放');

  cookie = '';
  check('KC005 孙浩(市场部)登录', await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]));
  const marketReadTech = await api('GET', `/nodes/${nodeId('技术方案')}`);
  check('市场部的人能读技术部的文档详情 → 200', marketReadTech.status === 200);
  const marketReadContent = await api('GET', `/nodes/${nodeId('技术方案')}/content`);
  check('也能读它的正文 → 200', marketReadContent.status === 200);
  const marketTree = (await api('GET', '/org/tree')).body;
  check(
    '组织树对所有人是全集(不做权限过滤)',
    marketTree.nodes.length === tree.nodes.length,
    `孙浩看到 ${String(marketTree.nodes.length)} 个,超管看到 ${String(tree.nodes.length)} 个`,
  );
  check(
    '孙浩的可编辑集合只含他真正能改的(市场部那条线)',
    marketTree.editableNodeIds.includes(nodeId('市场部工作方式')) &&
      !marketTree.editableNodeIds.includes(nodeId('技术方案')),
  );

  // ============================================================
  // C. 改:越靠上权限越大
  // ============================================================
  console.log('\nC. 编辑权:所有者 + 祖先链 + 显式授权');

  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const chen = await whoami();

  /** 改标题当写操作探针:它走的是同一个 requireEdit 闸门。 */
  async function tryRename(title, suffix) {
    const detail = (await api('GET', `/nodes/${nodeId(title)}`)).body;
    return api('PATCH', `/nodes/${nodeId(title)}`, {
      title: `${title}${suffix}`,
      version: detail.version,
    });
  }

  const chenRename = await tryRename('研发规范', '');
  check('陈默(技术部部长)能改本部门的文档 → 200', chenRename.status === 200);

  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const marketRename = await tryRename('研发规范', '');
  check('孙浩(别部门部长)不能改 → 403', marketRename.status === 403);

  cookie = '';
  await login('KC004', [INITIAL_PASSWORD, SEED_PASSWORD]);
  const zhao = await whoami();
  const zhaoRenameTech = await tryRename('技术方案', '');
  check('赵敏(后端组组员)不能改技术部直属的文档 → 403', zhaoRenameTech.status === 403);
  const zhaoRenameApi = await tryRename('接口规范', '');
  check('赵敏能改「接口规范」(她在这个节点被显式授权)→ 200', zhaoRenameApi.status === 200);

  const zhaoReadTech = await api('GET', `/nodes/${nodeId('技术方案')}`);
  check(
    '节点详情里带回「我能否改/管」,前端据此隐藏按钮',
    zhaoReadTech.body?.canEdit === false && zhaoReadTech.body?.canManage === false,
  );

  cookie = '';
  await login('KC003', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const wang = await whoami();
  const wangRenameApi = await tryRename('接口规范', '');
  check('王思远(后端组组长,在祖先链上)能改 → 200', wangRenameApi.status === 200);

  // ============================================================
  // D. 新建:边界在"你所属的节点"
  // ============================================================
  console.log('\nD. 新建的边界');

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const underOwnGroup = await api('POST', '/nodes', {
    parentId: nodeId('后端组'),
    kind: 'document',
    title: '赵敏的临时笔记',
  });
  check('赵敏能在自己所属的「后端组」下新建 → 201', underOwnGroup.status === 201);

  const underOtherGroup = await api('POST', '/nodes', {
    parentId: nodeId('CRM 项目'),
    kind: 'document',
    title: '不该建在这里',
  });
  check('赵敏不能在「CRM 项目」下新建(她不属于那个组)→ 403', underOtherGroup.status === 403);

  const underOtherDept = await api('POST', '/nodes', {
    parentId: nodeId('市场部'),
    kind: 'document',
    title: '不该建在这里',
  });
  check('也不能在「市场部」下新建 → 403', underOtherDept.status === 403);

  const topLevel = await api('POST', '/nodes', { parentId: null, kind: 'space', title: '赵敏建的部门' });
  check('非超管不能新建一级部门 → 403', topLevel.status === 403);

  check(
    '新建出来的节点归创建者所有',
    underOwnGroup.body?.ownerId === zhao?.id,
    `ownerId=${String(underOwnGroup.body?.ownerId)}, 赵敏 id=${String(zhao?.id)}`,
  );
  check(
    '新建后她自己可改(她是所有者)',
    underOwnGroup.body?.canEdit === true && underOwnGroup.body?.canManage === true,
  );

  // 组长能改组员建的页面 —— 「A 建的东西,A 的领导也能改」
  cookie = '';
  await login('KC003', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const wangEditZhaoPage = await api('PATCH', `/nodes/${underOwnGroup.body.id}`, {
    title: '赵敏的临时笔记(组长改过)',
    version: underOwnGroup.body.version,
  });
  check('王思远(组长)能改赵敏建的页面 → 200', wangEditZhaoPage.status === 200);

  // ============================================================
  // E. 授权与组织范围约束
  // ============================================================
  console.log('\nE. 授权:只能授给组织范围内的人');

  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const grants = (await api('GET', `/nodes/${nodeId('接口规范')}/grants`)).body;
  check('陈默能读授权视图,canManage 为真', grants?.canManage === true);
  check(
    '授权视图分三段:所有者 / 上级所有者 / 显式授权',
    grants?.owner?.employeeNo === 'KC002' && Array.isArray(grants.inherited) && Array.isArray(grants.grants),
  );
  check('赵敏已在授权名单里', grants?.grants?.some((row) => row.employeeNo === 'KC004'));

  const grantToOutsider = await api('PUT', `/nodes/${nodeId('接口规范')}/grants`, {
    version: grants.version,
    userIds: [userId('KC005')],
  });
  check(
    '陈默给市场部的孙浩授权 → 403(超出组织范围)',
    grantToOutsider.status === 403,
    `实际 ${String(grantToOutsider.status)}`,
  );

  const grantToInsider = await api('PUT', `/nodes/${nodeId('接口规范')}/grants`, {
    version: grants.version,
    userIds: [userId('KC003'), userId('KC004')],
  });
  check('陈默给本部门的王思远授权 → 200', grantToInsider.status === 200);

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const zhaoGrants = (await api('GET', `/nodes/${nodeId('接口规范')}/grants`)).body;
  check('被授权者读得到授权视图(读是开放的)', zhaoGrants !== null);
  check('但 canManage 为假 —— 被授权者不能转授', zhaoGrants?.canManage === false);
  const zhaoTryGrant = await api('PUT', `/nodes/${nodeId('接口规范')}/grants`, {
    version: zhaoGrants.version,
    userIds: [userId('KC004')],
  });
  check('被授权者写授权 → 403', zhaoTryGrant.status === 403);

  const zhaoImport = await api('POST', '/admin/org/import?dryRun=true');
  check('非超管调用组织架构导入 → 403', zhaoImport.status === 403);

  // ============================================================
  // F. 所有者变更:一级节点只有超管能动
  // ============================================================
  console.log('\nF. 所有者变更');

  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const chenSetDeptOwner = await api('PATCH', `/nodes/${nodeId('技术部')}/owner`, {
    ownerId: userId('KC004'),
  });
  check('部长不能改一级部门的所有者 → 403(否则等于自授权力)', chenSetDeptOwner.status === 403);
  const chenSetGroupOwner = await api('PATCH', `/nodes/${nodeId('后端组')}/owner`, {
    ownerId: userId('KC004'),
  });
  check('部长能改二级组的所有者 → 204(他是祖先链所有者)', chenSetGroupOwner.status === 204);
  // 改回来,免得影响后面的断言与人工验收
  await api('PATCH', `/nodes/${nodeId('后端组')}/owner`, { ownerId: wang?.id });

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const adminSetDeptOwner = await api('PATCH', `/nodes/${nodeId('技术部')}/owner`, { ownerId: chen?.id });
  check('超管能改一级部门的所有者 → 204', adminSetDeptOwner.status === 204);

  const assignOutsider = await api('PATCH', `/admin/users/${userId('KC005')}/assignments`, {
    nodeIds: [],
  });
  check('超管能把某人归属清空 → 200', assignOutsider.status === 200);
  await api('PATCH', `/admin/users/${userId('KC005')}/assignments`, {
    nodeIds: [nodeId('市场部')],
  });

  // ============================================================
  // G. 检索与导出
  // ============================================================
  console.log('\nG. 检索与导出(不做权限过滤)');

  const searchHit = await api('GET', `/search?q=${encodeURIComponent('递归查询')}`);
  check(
    '搜正文里的中文词能命中「技术方案」',
    searchHit.status === 200 && searchHit.body.hits.some((hit) => hit.title === '技术方案'),
    `命中 ${String(searchHit.body?.hits?.length ?? 0)} 条`,
  );
  check('命中结果带面包屑路径', (searchHit.body?.hits?.[0]?.breadcrumb?.length ?? 0) > 0);
  check('响应里带服务端耗时', typeof searchHit.body?.tookMs === 'number');

  const wildcard = await api('GET', '/search?q=%25');
  check(
    '搜「%」不会命中全部(LIKE 通配符已转义)',
    wildcard.body.hits.length < tree.nodes.length,
    `命中 ${String(wildcard.body.hits.length)} 条 / 树里 ${String(tree.nodes.length)} 个节点`,
  );

  const tooLong = await api('GET', `/search?q=${'字'.repeat(200)}`);
  check('超长关键词 → 400', tooLong.status === 400);

  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const marketSearch = await api('GET', `/search?q=${encodeURIComponent('递归查询')}`);
  check(
    '市场部的人也能搜到技术部的文档(读全员开放的必然结果)',
    marketSearch.body.hits.some((hit) => hit.title === '技术方案'),
  );

  const exported = await api('GET', `/nodes/${nodeId('技术方案')}/export?format=md`);
  check('导出 Markdown → 200', exported.status === 200);
  check('导出内容是 Markdown(含表格语法)', exported.text.includes('|') && exported.text.includes('技术栈'));

  // ============================================================
  // H. 评论
  // ============================================================
  console.log('\nH. 评论(全员可发)');

  const marketComment = await api('POST', `/nodes/${nodeId('技术方案')}/comments`, {
    body: '市场部路过,留个言试试。',
  });
  check('孙浩能在技术部的文档上评论 → 201(全员可发)', marketComment.status === 201);

  const reply = await api('POST', `/nodes/${nodeId('技术方案')}/comments`, {
    body: '回复一下',
    parentId: marketComment.body.id,
  });
  check('能回复顶层评论 → 201', reply.status === 201);

  const nestedReply = await api('POST', `/nodes/${nodeId('技术方案')}/comments`, {
    body: '回复的回复',
    parentId: reply.body.id,
  });
  check('回复的回复 → 400(只允许一层嵌套)', nestedReply.status === 400);

  const crossPage = await api('POST', `/nodes/${nodeId('研发规范')}/comments`, {
    body: '跨页面挂评论',
    parentId: marketComment.body.id,
  });
  check('跨页面的 parentId → 400', crossPage.status === 400);

  const deleteOthers = await api('DELETE', `/comments/${marketComment.body.id}`);
  check('孙浩能删自己的评论 → 204', deleteOthers.status === 204);

  // 换个人发一条,再用另一个身份去删 —— 应该被拒
  const someoneElse = await api('POST', `/nodes/${nodeId('技术方案')}/comments`, {
    body: '我来评论一句。',
  });
  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const deleteByOther = await api('DELETE', `/comments/${someoneElse.body.id}`);
  check('赵敏删别人的评论 → 403', deleteByOther.status === 403);

  // ============================================================
  // I. 回收站:能改就能软删,能管才能彻底删
  // ============================================================
  console.log('\nI. 回收站与彻底删除');

  cookie = '';
  await login('KC003', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const deleted = await api('DELETE', `/nodes/${underOwnGroup.body.id}`);
  check('组长能软删组员建的页面 → 200 且 removedCount 为 1', deleted.status === 200 && deleted.body.removedCount === 1);

  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const marketTrash = await api('GET', '/trash');
  check(
    '别人的回收站条目不会出现在孙浩这里',
    !marketTrash.body.some((item) => item.id === underOwnGroup.body.id),
  );

  cookie = '';
  await login('KC003', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const ownTrash = await api('GET', '/trash');
  check('王思远的回收站里能看到它', ownTrash.body.some((item) => item.id === underOwnGroup.body.id));
  check(
    '回收站条目带 deletedByName 与 parentAlive',
    typeof ownTrash.body[0]?.deletedByName === 'string' && typeof ownTrash.body[0]?.parentAlive === 'boolean',
  );

  // 当前身份是王思远(后端组组长),他对「接口规范」有管理权 ——
  // 所以这一个会走到"必须先软删除"那条校验,而不是被 403 挡在前面。
  const purgeLive = await api('DELETE', `/nodes/${nodeId('接口规范')}/purge`);
  check('对没进回收站的节点彻底删除 → 400', purgeLive.status === 400, `实际 ${String(purgeLive.status)}`);

  // POST 的默认状态码是 201,不是 200 —— 这里两种都接受,
  // 免得测试因为框架默认值而误报
  const restored = await api('POST', `/nodes/${underOwnGroup.body.id}/restore`);
  check('恢复 → 2xx', restored.status === 200 || restored.status === 201, `实际 ${String(restored.status)}`);
  check('恢复后能重新读到', (await api('GET', `/nodes/${underOwnGroup.body.id}`)).status === 200);

  // 彻底删除:门槛是 canManage(祖先链所有者),被授权者与被删页面自己没有权限。
  // 用陈默(技术部部长)来验 —— 他是这棵树的所有者链顶端。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const deletedAgain = await api('DELETE', `/nodes/${underOwnGroup.body.id}`);
  check('再次软删 → 200', deletedAgain.status === 200);
  const purged = await api('DELETE', `/nodes/${underOwnGroup.body.id}/purge`);
  check('所有者彻底删除 → 204', purged.status === 204, `实际 ${String(purged.status)}`);
  check(
    '彻底删除后真的读不到了 → 404',
    (await api('GET', `/nodes/${underOwnGroup.body.id}`)).status === 404,
  );

  // 被授权者不能彻底销毁(能改不代表能销毁)
  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const purgedByGrantee = await api('DELETE', `/nodes/${nodeId('接口规范')}/purge`);
  check('被授权者对活着的节点彻底删除 → 400 或 403(都不能销毁)', purgedByGrantee.status === 400 || purgedByGrantee.status === 403);

  // ============================================================
  // J. 上传白名单
  // ============================================================
  console.log('\nJ. 附件上传');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'x.svg');
  const svgUpload = await fetch(`${BASE}/uploads`, {
    method: 'POST',
    headers: cookie === '' ? {} : { Cookie: cookie },
    body: form,
  });
  check('上传 .svg → 400(SVG 能内嵌脚本,是 XSS 载体)', svgUpload.status === 400);

  const form2 = new FormData();
  form2.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'ok.png');
  const pngUpload = await fetch(`${BASE}/uploads`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form2,
  });
  const pngBody = await pngUpload.json().catch(() => null);
  check('上传 .png → 201 且返回服务端生成的 URL', pngUpload.status === 201 && /^\/uploads\/[0-9a-f-]+\.png$/.test(pngBody?.url ?? ''), JSON.stringify(pngBody));
  if (pngBody?.url !== undefined) {
    // ⚠️ 静态文件的直出方是 **Nginx(web 容器)**,不是 API 容器。
    // 所以这一项能不能验,取决于脚本跑在哪:
    //   - 宿主机上跑 → KC_ROOT 指到对外入口(默认 http://127.0.0.1:8080)
    //   - 在 api 容器里跑 → KC_ROOT 要用 compose 的服务名(http://web)
    //     因为 api 容器自己监听的是 3000,不是 8080。
    // 不可达时**明确报"跳过"**而不是抛异常 —— 验收脚本自己崩掉,
    // 会让"通过了几项"这个结论变得没有意义。
    try {
      const served = await fetch(`${ROOT}${pngBody.url}`);
      check(`由 Nginx 直出静态文件 → 200(${ROOT})`, served.status === 200, `HTTP ${String(served.status)}`);
    } catch (error) {
      console.log(
        `  · 跳过静态直出检查:${ROOT} 从这里不可达(${error instanceof Error ? error.message : '未知'})`,
      );
      console.log('    在 api 容器内跑时请设 KC_ROOT=http://web');
    }
  }

  // ============================================================
  // K. 审计
  // ============================================================
  console.log('\nK. 审计日志');

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const logs = await api('GET', '/audit-logs?limit=200');
  const actions = new Set((logs.body?.items ?? []).map((item) => item.action));
  check('超管能看到审计记录', logs.status === 200 && logs.body.items.length > 0);
  for (const action of ['auth.login', 'org.import', 'node.create', 'node.content.update', 'grant.replace', 'node.owner.update', 'comment.create', 'node.delete', 'node.restore']) {
    check(`审计里有 ${action}`, actions.has(action));
  }

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const zhaoLogs = await api('GET', '/audit-logs?limit=200');
  const zhaoActions = new Set((zhaoLogs.body?.items ?? []).map((item) => item.action));
  // 她能看到**自己拥有的节点**上的记录(那是她的地盘,应该能看见);
  // 但看不到别人的动作 —— 这才是要验的性质。
  check(
    '赵敏看不到组织架构导入这类与自己无关的记录',
    !zhaoActions.has('org.import'),
    `她看到的动作:${[...zhaoActions].join(', ') || '(无)'}`,
  );
  check(
    '赵敏看不到别人节点上的授权变更',
    !zhaoActions.has('grant.replace'),
    `她看到的动作:${[...zhaoActions].join(', ') || '(无)'}`,
  );

  // ============================================================
  // L. 节点成员(组织归属)与"调岗两步"
  // ============================================================
  console.log('\nL. 节点成员:这个节点下都有谁');

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);

  const techMembers = await api('GET', `/nodes/${nodeId('技术部')}/members`);
  check('超管能读「技术部」的成员 → 200', techMembers.status === 200);
  check(
    '直接成员是陈默(他的归属就挂在这一层)',
    techMembers.body?.direct?.some((member) => member.employeeNo === 'KC002') === true,
  );
  check(
    '王思远与赵敏落在「下属成员」里(他们归属在下面的组)',
    techMembers.body?.inherited?.some((member) => member.employeeNo === 'KC003') === true &&
      techMembers.body?.inherited?.some((member) => member.employeeNo === 'KC004') === true,
  );
  check(
    '超管在成员视图里 canManage 为真(组织架构归他管)',
    techMembers.body?.canManage === true,
  );

  const wangInTech = techMembers.body?.inherited?.find((member) => member.employeeNo === 'KC003');
  check(
    '王思远在这棵子树里有两条归属(后端组 + CRM 项目)',
    (wangInTech?.memberNodeIds?.length ?? 0) >= 2,
    `实际 ${String(wangInTech?.memberNodeIds?.length ?? 0)} 条:${(wangInTech?.memberPaths ?? []).join('、')}`,
  );

  // ---- 读全员开放,写有门槛 ----
  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const zhaoReadMembers = await api('GET', `/nodes/${nodeId('后端组')}/members`);
  check('组员也能读成员列表(读全员开放,与整棵树一致)', zhaoReadMembers.status === 200);
  check('但她的 canManage 为假 —— 界面据此隐藏按钮', zhaoReadMembers.body?.canManage === false);

  const zhaoAddMember = await api('POST', `/nodes/${nodeId('后端组')}/members`, {
    userId: userId('KC004'),
  });
  check('组员给自己加归属 → 403', zhaoAddMember.status === 403);

  const zhaoRemoveMember = await api('DELETE', `/nodes/${nodeId('后端组')}/members/${userId('KC003')}`);
  check('组员移出别人 → 403', zhaoRemoveMember.status === 403);

  // ---- 部长:能管本部门,但受组织范围约束 ----
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const chenMembers = await api('GET', `/nodes/${nodeId('技术部')}/members`);
  check('部长读本部门成员,canManage 为真', chenMembers.body?.canManage === true);

  const addOutsider = await api('POST', `/nodes/${nodeId('技术部')}/members`, {
    userId: userId('KC005'),
  });
  check('部长把市场部的孙浩加进技术部 → 403(超出组织范围)', addOutsider.status === 403);

  const addInsider = await api('POST', `/nodes/${nodeId('CRM 项目')}/members`, {
    userId: userId('KC004'),
  });
  check('部长把本部门的赵敏加进「CRM 项目」→ 200', addInsider.status === 200, `实际 ${String(addInsider.status)}`);
  check(
    '加完之后她出现在「CRM 项目」的直接成员里',
    addInsider.body?.direct?.some((member) => member.employeeNo === 'KC004') === true,
  );

  const addAgain = await api('POST', `/nodes/${nodeId('CRM 项目')}/members`, {
    userId: userId('KC004'),
  });
  check(
    '重复加同一个人是幂等的(不报错、也不会产生第二条)',
    addAgain.status === 200 &&
      addAgain.body?.direct?.filter((member) => member.employeeNo === 'KC004').length === 1,
    `实际 ${String(addAgain.status)}`,
  );

  const removeWrong = await api('DELETE', `/nodes/${nodeId('CRM 项目')}/members/${userId('KC002')}`);
  check('移出一个并不归属在这里的人 → 400', removeWrong.status === 400, `实际 ${String(removeWrong.status)}`);

  const removeZhao = await api('DELETE', `/nodes/${nodeId('CRM 项目')}/members/${userId('KC004')}`);
  check('把赵敏从「CRM 项目」移出 → 200(这就是调岗的第二步)', removeZhao.status === 200);
  check(
    '移出后她不再出现在直接成员里',
    removeZhao.body?.direct?.some((member) => member.employeeNo === 'KC004') !== true,
  );

  // ---- 组长管自己组;管不到上级 ----
  cookie = '';
  await login('KC003', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const wangOwnGroup = await api('GET', `/nodes/${nodeId('后端组')}/members`);
  check('组长能管自己组的成员', wangOwnGroup.body?.canManage === true);
  check(
    '王思远在「后端组」被标为所有者(移出归属**不会**改变这一点)',
    wangOwnGroup.body?.direct?.find((member) => member.employeeNo === 'KC003')?.isOwnerHere === true,
  );
  const wangDept = await api('GET', `/nodes/${nodeId('技术部')}/members`);
  check('组长对上级部门没有管理权', wangDept.body?.canManage === false);

  // ---- 候选人:成员与授权是两条接口,门槛不同 ----
  const wangCandidates = await api('GET', `/nodes/${nodeId('后端组')}/member-candidates`);
  check(
    '组长的候选人只含自己组织范围内的人(不含市场部)',
    wangCandidates.status === 200 &&
      wangCandidates.body.some((candidate) => candidate.employeeNo === 'KC004') &&
      !wangCandidates.body.some((candidate) => candidate.employeeNo === 'KC005'),
  );

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const adminCandidates = await api('GET', `/nodes/${nodeId('技术部')}/member-candidates`);
  check(
    '超管的候选人不做组织范围限制(组织架构本来就是他的职责)',
    adminCandidates.status === 200 &&
      adminCandidates.body.some((candidate) => candidate.employeeNo === 'KC005'),
  );

  const addDeparted = await (async () => {
    await api('PATCH', `/admin/users/${userId('KC005')}`, { status: 'departed' });
    const attempt = await api('POST', `/nodes/${nodeId('技术部')}/members`, {
      userId: userId('KC005'),
    });
    await api('PATCH', `/admin/users/${userId('KC005')}`, { status: 'active' });
    return attempt;
  })();
  check('把已离职的人加进组织 → 400', addDeparted.status === 400, `实际 ${String(addDeparted.status)}`);

  // ============================================================
  // M. 回收站保留策略 + 树的按根查询
  // ============================================================
  console.log('\nM. 回收站保留策略与树的按根查询');

  const policy = await api('GET', '/trash/policy');
  check(
    '保留策略可读,天数是个数字(界面文案靠它,不能前端硬编码)',
    policy.status === 200 && typeof policy.body?.retentionDays === 'number',
    JSON.stringify(policy.body),
  );
  check(
    '默认保留 30 天',
    policy.body?.retentionDays === 30 || policy.body?.retentionDays > 0,
    `实际 ${String(policy.body?.retentionDays)}`,
  );

  // ---- 软删一个节点:它必须**不**被保留策略清掉 ----
  // 这一条防的是"保留策略配错了,一跑就把整个回收站清空"。
  // 对象用**顶层文档**:超管只能在顶层建(他不是任何部门的内容所有者),这正是设计如此。
  const victim = await api('POST', '/nodes', {
    parentId: null,
    kind: 'document',
    title: 'M 组的临时页面',
  });
  check('超管能在顶层新建文档 → 201', victim.status === 201, `实际 ${String(victim.status)}`);
  check('超管是它的所有者(能改能删)', victim.body?.canEdit === true);
  await api('DELETE', `/nodes/${victim.body.id}`);

  const dryRun = await api('POST', '/admin/maintenance/trash-purge?dryRun=true');
  check('超管空跑一次保留策略清理 → 200', dryRun.status === 200, `实际 ${String(dryRun.status)}`);
  check('空跑不删任何东西', dryRun.body?.purgedNodes === 0);
  check(
    '刚删的节点**不**在待清理列表里(保留期内不会被清掉)',
    !(dryRun.body?.roots ?? []).some((root) => root.id === victim.body.id),
    `待清理 ${String(dryRun.body?.roots?.length ?? 0)} 棵`,
  );

  const purgeRun = await api('POST', '/admin/maintenance/trash-purge');
  check('真跑一次 → 200', purgeRun.status === 200);
  check(
    '没有到期条目时清掉 0 个节点',
    purgeRun.body?.purgedNodes === 0,
    `实际 ${String(purgeRun.body?.purgedNodes)}`,
  );
  const trashAfter = await api('GET', '/trash');
  check(
    '刚删的节点仍然躺在回收站里,可以恢复',
    trashAfter.body.some((item) => item.id === victim.body.id),
  );

  // 收尾:把它彻底删掉,免得污染后续断言与人工验收
  const cleanup = await api('DELETE', `/nodes/${victim.body.id}/purge`);
  check('收尾:超管彻底删除它 → 204', cleanup.status === 204, `实际 ${String(cleanup.status)}`);

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const zhaoPurgeByPolicy = await api('POST', '/admin/maintenance/trash-purge');
  check('非超管手动清理回收站 → 403', zhaoPurgeByPolicy.status === 403);

  // ---- 树的按根查询 ----
  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const fullTree = (await api('GET', '/org/tree')).body;
  const techSubtree = await api('GET', `/org/tree?root=${nodeId('技术部')}`);
  check('按根查子树 → 200', techSubtree.status === 200);
  check(
    '子树里只有技术部这条线,不含市场部',
    !techSubtree.body.nodes.some((node) => node.title === '市场部'),
  );
  check(
    '子树含自身与后代',
    techSubtree.body.nodes.some((node) => node.title === '技术部') &&
      techSubtree.body.nodes.some((node) => node.title === '后端组'),
  );
  check(
    '子树的节点数严格少于全树',
    techSubtree.body.nodes.length < fullTree.nodes.length,
    `子树 ${String(techSubtree.body.nodes.length)} / 全树 ${String(fullTree.nodes.length)}`,
  );

  check(
    'root 不是 UUID → 400(而不是 500)',
    (await api('GET', '/org/tree?root=not-a-uuid')).status === 400,
  );
  check(
    'root 不存在 → 404(而不是静默返回空树)',
    (await api('GET', '/org/tree?root=00000000-0000-4000-8000-000000000000')).status === 404,
  );

  // ⚠️ 这一对断言是「按根查询」里最容易做错的地方:**祖先链必须仍然参与判权**。
  // 只返回子树时,祖先不在返回集里,若不为判权单独补查,
  // 子树里每个节点都会被算成"我改不了"—— 而且不报任何错。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const chenLeaf = await api('GET', `/org/tree?root=${nodeId('接口规范')}`);
  check(
    '只查一个深层叶子时,祖先链仍然参与判权(部长能改它)',
    chenLeaf.status === 200 && chenLeaf.body.editableNodeIds.includes(nodeId('接口规范')),
    `editableNodeIds=${JSON.stringify(chenLeaf.body?.editableNodeIds)}`,
  );
  check(
    '响应里确实只有那一棵子树的节点',
    chenLeaf.body.nodes.length === 1,
    `实际 ${String(chenLeaf.body?.nodes?.length ?? 0)} 个`,
  );

  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const marketLeaf = await api('GET', `/org/tree?root=${nodeId('接口规范')}`);
  check(
    '别部门的人查同一棵子树,权限标记依然是对的(不含它)',
    marketLeaf.status === 200 &&
      !marketLeaf.body.editableNodeIds.includes(nodeId('接口规范')),
  );

  // ============================================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`通过 ${String(passed)} 项,失败 ${String(failed)} 项`);
  if (failed > 0) process.exit(1);
  console.log('✅ v2.0 权限模型端到端验收全部通过');
}

await main();
