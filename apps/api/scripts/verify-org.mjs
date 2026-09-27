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
 * ## 副作用会**自己还原**(v2.6 起,细节在 v2.7 补全)
 *
 * A 组那段「首次登录改密」不是演给你看的 —— 它**真的**会把 KC003 的密码
 * 从 `123456` 改成 `KC_SEED_PASSWORD`;`login()` 这个辅助函数在遇到
 * "需要先改密"的账号时也会顺手改掉,所以 KC004 同样会被改。
 *
 * 脚本还会**建节点**(验"新建的边界")、**改所有者**(验"谁能任命组长"),
 * 并临时把 KC005 标成离职。
 *
 * ⚠️ v2.5 及以前,这些改动**没有任何地方还原**,后果三条,都真的踩过:
 *   1. 跑过一次验收,`DEMO-ACCOUNTS.txt` 里写的 `123456` 就登不上了
 *   2. 下一轮 A 组走"跳过"分支,总项数比满项少几项 —— 看着像回归,其实是
 *      上一轮脚本自己造成的
 *   3. **v2.6 只还原了密码,没还原节点与所有者** —— 于是服务器上积了 3 个
 *      「赵敏的临时笔记」,「后端组」的所有者还停在赵敏,而**下一轮运行开始失败**,
 *      失败的样子是「组长改不动内容了」,查了半天代码才发现是脚本自己的垃圾
 *
 * v2.7 起由 `restoreToolState()` 统一收尾:**密码 + 残留节点 + 被改的所有者**。
 * 它有两个调用点 —— 正常路径在 N 组结尾,异常时在文件末尾的 `finally` 兜底;
 * 而且**开头还会自检**:发现上一轮的残留就先自动清掉再跑,而不是带着脏前提失败。
 *
 * 所以本脚本是幂等的:跑几次结果都一样。若 N 组没跑到(脚本中途抛异常),
 * 手工还原:
 *
 *   docker compose exec api node scripts/reset-demo-passwords.mjs
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
 *
 * v2.5 追加一组:
 *   N. **重置密码(超管)** —— 判权、不能重置自己、重置会吊销已有会话、
 *      重置后仍然不下发会话;**并且把 KC003 / KC004 放回演示状态**。
 */

const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
const ROOT = process.env.KC_ROOT ?? 'http://127.0.0.1:8080';
const SEED_PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD ?? 'Kc-admin-2026';
const INITIAL_PASSWORD = '123456';

let passed = 0;
let failed = 0;

/**
 * 收尾还原是否已经在正常路径上跑过。
 *
 * 正常跑完时 N 组会调一次 `restoreToolState()`;若脚本中途抛异常,则走文件末尾
 * `finally` 里的兜底。用这个标记区分,避免"还原两次"(虽然幂等,但输出会重复)。
 */
let restoredByScript = false;

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

async function api(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie !== '') headers.Cookie = cookie;
  // multipart 的 Content-Type 必须由 fetch 自己填(boundary 是它生成的),所以这里跳过
  if (body !== undefined && !options.formData) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  syncCookie(response);

  // ⚠️ 先取**字节**再自己解码,不能用 `response.text()` ——
  // `Response.text()` 按 WHATWG 规范会**吃掉开头的 BOM**(它用默认的 UTF-8 解码,
  // 而 TextDecoder 默认忽略 BOM)。于是"导出带不带 BOM"这条断言
  // 在 `text()` 上**永远为假**,尽管字节流里 BOM 明明在(实测 `ef bb bf`)。
  // `Buffer.toString("utf8")` 不会吃 BOM,所以 `text` 与 `bytes` 都保留。
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  // `setCookie` 单独给出来:有一条断言必须看**响应头**才知道结果 ——
  // "首次登录不下发会话 Cookie"。只看 `cookie` 变量是看不出来的
  // (它会在没有新 Cookie 时保留上一次的值)。
  return {
    status: response.status,
    body: json,
    text,
    bytes,
    setCookie: response.headers.getSetCookie?.() ?? [],
  };
}

/** 响应里是否下发了会话 Cookie。 */
function issuedSession(response) {
  return response.setCookie.some((item) => item.startsWith('kc_session='));
}

/**
 * 登录,并**必要时完成首次改密**。
 *
 * ⚠️ v2.4 起首次登录不再建立会话,所以这里多了一段:
 * 拿到 `password-change-required` 就凭一次性凭证改密,然后用新密码**重新登录**
 * (改密后服务端仍然不给会话 —— 那是刻意的,所以脚本也必须真登一次)。
 *
 * 顺带把"首登改密"这条链路每次都验一遍。
 */
/**
 * 每个账号**已经试成功过的密码**。
 *
 * ⚠️ 这不是优化,是**正确性修复**。原来每次登录都从头遍历候选密码,
 * 而错的那几次会被 v2.12 的登录限流记成失败 —— 5 次就锁 15 分钟。
 * 后果:脚本跑到后半段时 KC004 已经被自己锁住,于是「名单里的人读得到」
 * 这类断言拿到的是 429/401,却被当成 404 记成失败。
 * **真机部署时就是这么误报的:7 条"失败"全部来自脚本自己,没有一条是产品缺陷。**
 */
const knownPassword = new Map();

/**
 * 登录。**登不上就抛错**,绝不"悄悄继续用上一个人的会话"。
 *
 * ⚠️⚠️ 这是 v2.12 真机验收时挖出来的一个**很危险的**脚本缺陷:
 * 原来登不上时只 `return false`,而**52 个调用点里只有 4 个看了返回值** ——
 * 于是其余 48 处会带着**上一步那个人的会话来发请求**。
 *
 * 实际后果:脚本想以「无关的人 KC004」去改可见范围,但 KC004 那次没登上,
 * 请求就带着**上一步 KC005(市场部所有者)的会话**发出去了 → 服务端返回 200,
 * 断言报「★ 无关的人改可见范围 → 200」—— **看起来像一次越权漏洞**。
 * 实际是脚本自己在冒充另一个人。这类假阳性比漏测更坏:
 * 它会让人去"修"一个根本不存在的安全问题,而真正的缺陷仍留在原处。
 *
 * 所以:每次登录**先把 cookie 清空**,登不上直接抛错。
 */
async function login(employeeNo, candidates) {
  // 试过的顺序要保住,但**已经知道对的那个排最前** —— 正常路径上就只有 1 次尝试
  const known = knownPassword.get(employeeNo);
  const ordered =
    known === undefined ? [...candidates] : [known, ...candidates.filter((c) => c !== known)];

  // 先清空:哪怕这次登不上,也绝不会把上一个人的会话带进下一步
  cookie = '';

  for (const password of ordered) {
    const attempt = await api('POST', '/auth/login', { employeeNo, password });

    // 429 = 被限流锁住了。**必须立刻说清楚**,不能继续往下走 ——
    // 否则后面每一条断言都会拿到 401/404,然后被报成"功能坏了"。
    if (attempt.status === 429) {
      const wait = String(attempt.body?.retryAfterSeconds ?? "?");
      throw new Error(
        `${employeeNo} 被登录限流锁住了(HTTP 429,还需约 ${wait} 秒)。` +
          "这不是功能缺陷,是 v2.12 的登录限流在生效。等它过期,或清掉计数:" +
          "  compose exec redis redis-cli --scan --pattern kc:login:*(逐个 del);" +
          "  也可以把 LOGIN_MAX_ATTEMPTS 设为 0 来关掉账号锁(IP 门仍生效)。",
      );
    }

    if (attempt.status !== 200 && attempt.status !== 201) continue;

    if (attempt.body?.kind === 'password-change-required') {
      const changed = await api('POST', '/auth/initial-password', {
        setupToken: attempt.body.setupToken,
        newPassword: SEED_PASSWORD,
      });
      if (changed.status !== 204) {
        throw new Error(
          `${employeeNo} 首登改密失败:HTTP ${String(changed.status)} ${JSON.stringify(changed.body)}`,
        );
      }
      const again = await api('POST', '/auth/login', { employeeNo, password: SEED_PASSWORD });
      if (again.status !== 200) {
        throw new Error(
          `${employeeNo} 改密之后重新登录失败:HTTP ${String(again.status)} ${JSON.stringify(again.body)}`,
        );
      }
      knownPassword.set(employeeNo, SEED_PASSWORD);
      console.log(`  · ${employeeNo} 用初始密码登录 → 被要求先改密,改完重新登录(顺带验过这条链路)`);
      return true;
    }

    knownPassword.set(employeeNo, password);
    return true;
  }

  throw new Error(
    `${employeeNo} 登录失败:候选密码一个都不对(${candidates.join(" / ")})。` +
      "继续跑下去会带着**上一个人的会话**发请求,那比直接失败更坏,所以这里中止。" +
      "如果这个账号的密码不在候选里,把它加进调用处的候选列表。",
  );
}

/**
 * 只在"这个账号现在能不能登"本身是被测对象时用 —— 登不上返回 false,**不抛**。
 * 它会清空 cookie,所以调用方之后必须重新登录才能继续发请求。
 */
async function tryLogin(employeeNo, candidates) {
  try {
    await login(employeeNo, candidates);
    return true;
  } catch {
    cookie = '';
    return false;
  }
}

async function whoami() {
  const me = await api('GET', '/auth/me');
  return me.body?.user ?? null;
}

/** 数组兜底:断言里的 `.some(...)` 一旦拿到错误体就会抛异常,把脚本直接打断。 */
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 本脚本**自己创建出来**的节点标题 —— 收尾时按标题清理。
 *
 * ⚠️ 为什么需要这个清单:脚本会建节点(验"新建的边界")。正常路径下它们在 I 组被
 * 彻底删除,但**一旦中途异常,这些节点就永久留在库里**。
 *
 * 实测踩到:v2.6 那轮我在服务器上跑了几次,库里积了 3 个「赵敏的临时笔记」,
 * 于是**下一次运行开始失败** —— 而且失败的样子是"组长改不动内容了"(C 组),
 * 看起来像功能坏了,其实是脚本自己上一轮留下的垃圾把前提条件弄脏了。
 *
 * 按**标题**清理而不是按 id:崩掉那一轮拿到的 id 已经丢了,标题才是稳定的。
 * 代价——**不要用这些名字给自己建页面**(它们是测试数据专用名)。
 */
const TOOL_NODE_TITLES = [
  '赵敏的临时笔记',
  '赵敏的临时笔记(组长改过)',
  '不该建在这里',
  '赵敏建的部门',
  'M 组的临时页面',
];

/**
 * 演示数据的**归属基线** —— 与 `seed-dev.mjs` 那份 Excel 一致。
 *
 * ⚠️ 为什么需要它:L 组验「组员不能移出别人」时,请求的目标是**王思远**
 * (`DELETE /nodes/后端组/members/KC003`)。正常情况下服务端回 403(断言正是这么写的),
 * **但一旦前提状态不对**(比如某次崩溃后赵敏恰好成了那个组的所有者),
 * 这一刀就会**真的砍下去** —— 王思远从此不在「后端组」里,
 * 于是后面所有"组长能改自己组里东西"的断言跟着失败。
 *
 * 实测踩到过:服务器上王思远的归属只剩「CRM 项目」,
 * 表现成"组长改不动自己组的东西"。又一次是脚本自己造成的。
 *
 * 教训和 v2.6/v2.7 完全一样:**脚本改了什么,就要能收回什么** ——
 * 密码、节点、所有者都收了,唯独归属没收。
 */
const EXPECTED_ASSIGNMENTS = {
  KC002: ['技术部'],
  KC003: ['后端组', 'CRM 项目'],
  KC004: ['后端组'],
  KC005: ['市场部'],
};

/**
 * 把脚本改过的东西放回去。
 *
 * **正常路径在 N 组结尾调一次;异常时在 `finally` 里再兜一次**(见文件末尾)。
 * 这是 v2.6 教训的推广:v2.6 只还原了**密码**,v2.7 补上**节点**与**所有者** ——
 * 脚本对系统状态做的任何修改,都必须由脚本自己收回。
 *
 * 四件事:
 *   1. 清掉脚本建出来的残留节点
 *   2. 把「后端组」的所有者放回王思远(F 组会临时改成赵敏)
 *   3. 把演示账号的**组织归属**放回基线(v2.8 补 —— L 组会真的移出归属)
 *   4. 把 KC003 / KC004 的密码放回「初始密码 + 待首次登录」
 *
 * ⚠️ 第 1 步为什么需要**换几个身份试**:
 *
 * 彻底删除要 `canManage`,而它的定义是「自己就是所有者,或祖先链上有我」
 * (`permission.ts` 的 `canManage`)。超管**不在其列** —— 他不自动拥有内容管理权,
 * 这是 §5.1 刻意的隔离。
 *
 * 所以:
 *   · 超管**改不了一级之外节点的所有者**(`setOwner` 只有根节点才要求超管,
 *     其余要 `requireManage`),于是"超管先接管再删"这条路走不通(实测 403)。
 *   · 但**节点自己的所有者能删自己的**(`self.ownerId === actor.id`)。
 *   · **祖先所有者也能删** —— 陈默(技术部部长)能删技术部下的任何东西。
 *
 * 于是按 陈默 → 赵敏 → 超管 的顺序试。这不是"防御性编程",是**权限模型决定的**:
 * 脚本建出来的节点分属不同的人与层级,没有一个身份能通吃。
 */
async function restoreToolState() {
  const notes = [];

  try {
    cookie = '';
    if (!(await tryLogin('KC001', [ADMIN_PASSWORD]))) {
      notes.push('拿不到超管会话,未能还原');
      return notes;
    }

    const users = arr((await api('GET', '/admin/users?limit=500')).body.users);
    const wangId = users.find((u) => u.employeeNo === 'KC003')?.id;
    const tree = (await api('GET', '/org/tree')).body ?? { nodes: [] };

    // 1) 残留节点。
    //
    // 身份顺序:陈默(技术部的祖先所有者,管得住技术部下面的一切)→ 赵敏(她建的
    // 顶层节点只有她自己删得动)→ 超管(只对他自己建的顶层节点有效)。
    const identities = [
      ['KC002', [SEED_PASSWORD, INITIAL_PASSWORD]],
      ['KC004', [INITIAL_PASSWORD, SEED_PASSWORD]],
      ['KC001', [ADMIN_PASSWORD]],
    ];

    for (const title of TOOL_NODE_TITLES) {
      for (const node of arr(tree.nodes).filter((n) => n.title === title)) {
        let cleaned = null;

        for (const [employeeNo, passwords] of identities) {
          cookie = '';
          if (!(await tryLogin(employeeNo, passwords))) continue;

          // v2.12 起 `DELETE /nodes/:id` 本身就是物理删除,一次调用删干净整棵子树
          // (以前要"先软删、再彻底删"两步,现在没有回收站了)。
          const hard = await api('DELETE', `/nodes/${node.id}`);
          if (hard.status < 300) {
            cleaned = employeeNo;
            break;
          }
        }

        notes.push(
          cleaned === null
            ? `清残留节点「${title}」**失败** —— 没有任何身份删得动它,请手工处理`
            : `清残留节点「${title}」(以 ${cleaned} 身份)`,
        );
      }
    }

    // 2) 「后端组」的所有者。一级部门以外的节点,超管改不动所有者 ——
    //    所以这里必须由**当前的管理者**来做:技术部的所有者(陈默)在祖先链上。
    const group = arr(tree.nodes).find((n) => n.title === '后端组');
    if (group !== undefined && wangId !== undefined) {
      const detail = await api('GET', `/nodes/${group.id}`);
      if (detail.body?.ownerId !== wangId) {
        cookie = '';
        await login('KC002', [SEED_PASSWORD, INITIAL_PASSWORD]);
        const fixed = await api('PATCH', `/nodes/${group.id}/owner`, { ownerId: wangId });
        notes.push(
          `「后端组」所有者放回王思远${fixed.status === 204 ? '' : `**失败**(${String(fixed.status)})`}`,
        );
      } else {
        notes.push('「后端组」所有者本来就是王思远,无需还原');
      }
    }

    // 3) 组织归属回到基线。
    //
    // 这一步是 v2.8 补的。脚本会**真的移出某人的归属**(见 `EXPECTED_ASSIGNMENTS`
    // 的注释),而在此之前它只还原密码、节点、所有者 —— 归属没收,
    // 于是王思远的「后端组」丢了,后面所有"组长能管本组"的断言全部失败。
    for (const [employeeNo, titles] of Object.entries(EXPECTED_ASSIGNMENTS)) {
      const user = users.find((u) => u.employeeNo === employeeNo);
      if (user === undefined) continue;

      const wantIds = titles
        .map((title) => arr(tree.nodes).find((n) => n.title === title)?.id)
        .filter((id) => id !== undefined);
      const have = [...(user.scopeNodeIds ?? [])].sort().join('|');
      const want = [...wantIds].sort().join('|');
      if (have === want) continue;

      const fixed = await api('PATCH', `/admin/users/${user.id}/assignments`, {
        nodeIds: wantIds,
      });
      notes.push(
        `把 ${employeeNo} 的归属放回「${titles.join('、')}」${fixed.status === 200 ? '' : `**失败**(${String(fixed.status)})`}`,
      );
    }

    // 4) 演示账号密码(超管才能做)
    cookie = '';
    await login('KC001', [ADMIN_PASSWORD]);
    for (const employeeNo of ['KC003', 'KC004']) {
      const id = users.find((u) => u.employeeNo === employeeNo)?.id;
      if (id === undefined) continue;
      const done = await api('POST', `/admin/users/${id}/reset-password`, {});
      notes.push(
        `${employeeNo} 密码放回 123456${done.status === 200 ? '' : ` **失败**(${String(done.status)})`}`,
      );
    }
  } catch (error) {
    notes.push(`还原过程出错:${String(error)}`);
  }

  return notes;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`接口: ${BASE}\n`);

  // ============================================================
  // A. 认证与首次登录改密
  // ============================================================
  console.log('A. 认证与首次登录改密');

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

  // ---- 首次登录:不建立会话,只给一张一次性凭证(v2.4 重做) ----
  //
  // 这一段的核心是一条**否定性断言**:服务端不下发会话 Cookie。
  // 旧实现是"照样登录、再由守卫拦住业务接口",结果人卡在半登录态 ——
  // 进不去系统,也退不出去。用户明确要求「第一次登录不应该记录登录状态」。
  cookie = '';
  const firstLogin = await api('POST', '/auth/login', {
    employeeNo: 'KC003',
    password: INITIAL_PASSWORD,
  });

  if (firstLogin.status !== 200) {
    console.log('  · KC003 已经设过密码了(脚本跑过一次),跳过首次改密那一段');
    console.log('    想重跑这一段:docker compose exec api node scripts/reset-demo-passwords.mjs');
  } else {
    check(
      '首次登录返回 kind = password-change-required(登录是**两种结果**之一)',
      firstLogin.body?.kind === 'password-change-required',
      JSON.stringify(firstLogin.body).slice(0, 120),
    );
    check(
      '★ 首次登录**不下发会话 Cookie**(不记录登录状态)',
      !issuedSession(firstLogin),
      `Set-Cookie: ${firstLogin.setCookie.join(' | ') || '(空)'}`,
    );
    check(
      '带回一张一次性凭证(两段式,点分隔)',
      typeof firstLogin.body?.setupToken === 'string' &&
        firstLogin.body.setupToken.split('.').length === 2,
    );

    // 没有会话 → 对业务接口而言他就是**未登录**
    check(
      '首登之后访问业务接口 → 401(不是 403 —— 他压根没有登录状态)',
      (await api('GET', '/org/tree')).status === 401,
    );

    // 改密:**不要原密码**
    const weak = await api('POST', '/auth/initial-password', {
      setupToken: firstLogin.body.setupToken,
      newPassword: '12345678',
    });
    check('首登改密用弱密码(纯数字)→ 400', weak.status === 400);

    const forged = await api('POST', '/auth/initial-password', {
      setupToken: 'forged.payload',
      newPassword: SEED_PASSWORD,
    });
    check('伪造的凭证改密 → 401', forged.status === 401);

    const okChange = await api('POST', '/auth/initial-password', {
      setupToken: firstLogin.body.setupToken,
      newPassword: SEED_PASSWORD,
    });
    check(
      '首登改密(**不需要原密码**)→ 204',
      okChange.status === 204,
      `实际 ${String(okChange.status)}`,
    );

    check(
      '★ 改完之后**仍然没有会话** —— 必须重新登录',
      !issuedSession(okChange) && (await api('GET', '/org/tree')).status === 401,
    );

    // 凭证是一次性的:用户状态一翻转,这张就作废了
    const reuse = await api('POST', '/auth/initial-password', {
      setupToken: firstLogin.body.setupToken,
      newPassword: 'Another1234',
    });
    check('同一张凭证不能复用 → 401(一次性)', reuse.status === 401);

    cookie = '';
    const relogin = await api('POST', '/auth/login', {
      employeeNo: 'KC003',
      password: SEED_PASSWORD,
    });
    check(
      '用新密码重新登录 → kind = session',
      relogin.status === 200 && relogin.body?.kind === 'session',
    );
    check('★ 这一次才下发会话 Cookie', issuedSession(relogin));
    check('新会话能访问业务接口 → 200', (await api('GET', '/org/tree')).status === 200);
  }

  // ---- 已登录用户主动改密:仍然要原密码(v2.4 把它与首登改密彻底分开) ----
  //
  // 首登不要原密码,理由很直白:登录那一步刚验过一次,再要就是重复。
  // 已登录改密要原密码,理由不同:会话可能被他人接管(电脑没锁屏)。
  // 两条路径的身份依据不一样,所以是两条接口、两套校验 —— 不是"重复实现"。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);

  const wrongCurrent = await api('POST', '/auth/change-password', {
    currentPassword: 'not-the-password',
    newPassword: 'Another1234',
  });
  check('已登录改密:当前密码不对 → 401', wrongCurrent.status === 401);

  const weakNew = await api('POST', '/auth/change-password', {
    currentPassword: SEED_PASSWORD,
    newPassword: '12345678',
  });
  check('已登录改密:新密码太弱(纯数字)→ 400', weakNew.status === 400);

  const sameAsOld = await api('POST', '/auth/change-password', {
    currentPassword: SEED_PASSWORD,
    newPassword: SEED_PASSWORD,
  });
  check('已登录改密:新密码与当前相同 → 400', sameAsOld.status === 400);

  // 上面三条都不该动到密码 —— 用原密码再登一次确认
  cookie = '';
  check('三次失败的改密都没有动到密码(原密码仍可登录)', await login('KC002', [SEED_PASSWORD]));

  // ============================================================
  // 摸清树与人的位置(用超管)
  // ============================================================
  cookie = '';
  if (!(await tryLogin('KC001', [ADMIN_PASSWORD]))) {
    console.error('✗ 超管 KC001 登录失败 —— 先跑 pnpm seed:dev');
    process.exit(1);
  }
  const admin = await whoami();
  check('超管 KC001 登录成功且 isSuperAdmin 为真', admin?.isSuperAdmin === true);

  let tree = (await api('GET', '/org/tree')).body;
  const nodeId = (title) => tree.nodes.find((node) => node.title === title)?.id;
  let users = (await api('GET', '/admin/users?limit=500')).body.users;
  const userId = (employeeNo) => users.find((user) => user.employeeNo === employeeNo)?.id;

  for (const title of ['技术部', '市场部', '后端组', 'CRM 项目', '研发规范', '技术方案', '接口规范', '市场部工作方式']) {
    if (nodeId(title) === undefined) {
      console.error(`✗ 树里找不到「${title}」—— 先跑 pnpm seed:dev`);
      process.exit(1);
    }
  }
  console.log(`  · 树:${tree.nodes.map((n) => n.title).join('、')}`);

  // ---- 上一次运行的残留?先自愈再继续 ----
  //
  // ⚠️ 这一段是 v2.7 补的,补的是一个**很贵的坑**。
  //
  // 原来这里只检查"少没少标题",不检查"多没多东西"和"所有者对不对"。
  // 于是脚本自己上一轮崩掉时留下的测试节点、以及被改过没还原的所有者,
  // 会让这一轮的断言从一开始就失败 —— 而且失败的样子是
  // 「组长改不动内容了」,读起来像功能坏了。
  //
  // 实测:服务器上积了 3 个「赵敏的临时笔记」,「后端组」的所有者还是赵敏。
  // 我对着那个输出查了半天代码,最后才发现是脚本自己的垃圾。
  const groupOwnerId = (await api('GET', `/nodes/${nodeId('后端组')}`)).body?.ownerId;
  const groupOwnerNo = users.find((u) => u.id === groupOwnerId)?.employeeNo;
  const residue = tree.nodes.filter((node) => TOOL_NODE_TITLES.includes(node.title));
  const ownerWrong = groupOwnerNo !== 'KC003';

  // 归属也要查 —— L 组会真的移出某人的归属(见 `EXPECTED_ASSIGNMENTS`)。
  // 少了这一条,残留会以"组长改不动自己组里的东西"的形式暴露,极难往脚本上想。
  const assignmentIssues = Object.entries(EXPECTED_ASSIGNMENTS).flatMap(([employeeNo, titles]) => {
    const user = users.find((u) => u.employeeNo === employeeNo);
    if (user === undefined) return [`缺账号 ${employeeNo}`];
    const have = [...(user.scopeNodeIds ?? [])].sort().join('|');
    const want = titles
      .map((title) => nodeId(title))
      .filter((id) => id !== undefined)
      .sort()
      .join('|');
    return have === want ? [] : [`${employeeNo} 的归属与基线不一致`];
  });

  if (residue.length > 0 || ownerWrong || assignmentIssues.length > 0) {
    const why = [
      residue.length > 0 ? `多余测试节点 ${String(residue.length)} 个` : '',
      ownerWrong ? `「后端组」所有者是 ${String(groupOwnerNo)}` : '',
      ...assignmentIssues,
    ]
      .filter((x) => x !== '')
      .join('、');
    console.log(`  · 检测到上一次运行的残留(${why})—— 先自动还原`);
    for (const note of await restoreToolState()) console.log(`    · ${note}`);
    // 还原之后重新取一遍:下面的 nodeId / userId 闭包引用的是这两个变量
    tree = (await api('GET', '/org/tree')).body;
    users = (await api('GET', '/admin/users?limit=500')).body.users;
  }

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
  await login('KC004', [INITIAL_PASSWORD, SEED_PASSWORD, ADMIN_PASSWORD]);
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
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
  const underOwnGroup = await api('POST', '/nodes', {
    parentId: nodeId('后端组'),
    kind: 'document',
    title: '赵敏的临时笔记',
  });
  check('赵敏能在自己所属的「后端组」下新建 → 201', underOwnGroup.status === 201);
  /*
    ⚠️ 后面十几处都要用这个 id,所以在这里取一次并**允许为 undefined**。

    原来各处都直接写 `underOwnId` —— 一旦上一步失败(比如库里状态不对),
    `body` 是错误对象,`.id` 是 undefined,于是请求打到 `/nodes/undefined`,
    拿到 400,然后后面用 `.body.some(...)` 的断言**抛异常把整个脚本打断**,
    连最后的收尾还原都跑不到。实测就是这样把演示数据越弄越脏的。

    取一次 + 可选链之后:失败只会让后续断言**报错但继续跑**,收尾照常执行。
  */
  const underOwnId = underOwnGroup.body?.id;

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
  const wangEditZhaoPage = await api('PATCH', `/nodes/${underOwnId}`, {
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
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
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
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
  const deleteByOther = await api('DELETE', `/comments/${someoneElse.body.id}`);
  check('赵敏删别人的评论 → 403', deleteByOther.status === 403);

  // ============================================================
  // I. 删除:整棵子树物理删除、不可恢复(v2.12)
  // ============================================================
  console.log('\nI. 删除(物理删除整棵子树)');

  // ---- 门槛:能改 ≠ 能删 ----
  //
  // v2.12 之前删除是软删除(可恢复),所以门槛是 canEdit;现在删除不可逆,
  // 门槛提到 canManage(该节点或祖先链上的所有者)。
  //
  // 用现成数据来验太脆 —— 前面 G/H 组的授权断言会把名单改掉。所以这里**自建**
  // 一个样本:陈默(技术部部长)建页面 → 他把赵敏加进授权名单 →
  // 赵敏因此 canEdit,但她不是所有者/祖先所有者,所以 canManage 为假。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const thresholdPage = await api('POST', '/nodes', {
    parentId: nodeId('技术部'),
    kind: 'document',
    title: 'I 组的门槛样本',
  });
  check(
    '陈默在技术部下建页面 → 201',
    thresholdPage.status === 201,
    `实际 ${String(thresholdPage.status)}`,
  );
  const thresholdId = thresholdPage.body?.id;

  const thresholdGrants = (await api('GET', `/nodes/${thresholdId}/grants`)).body;
  const grantZhao = await api('PUT', `/nodes/${thresholdId}/grants`, {
    version: thresholdGrants?.version,
    userIds: [userId('KC004')],
  });
  check(
    '把赵敏加进它的授权名单 → 200',
    grantZhao.status === 200,
    `实际 ${String(grantZhao.status)}`,
  );

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
  const zhaoThreshold = (await api('GET', `/nodes/${thresholdId}`)).body;
  check(
    '★ 赵敏对该页 canEdit 为真、canManage 为假(这正是要看的那条边界)',
    zhaoThreshold?.canEdit === true && zhaoThreshold?.canManage === false,
    JSON.stringify({ canEdit: zhaoThreshold?.canEdit, canManage: zhaoThreshold?.canManage }),
  );
  const zhaoEditIt = await api('PATCH', `/nodes/${thresholdId}`, {
    title: 'I 组的门槛样本(赵敏改过)',
    version: zhaoThreshold?.version,
  });
  check(
    '★ 被授权者**能改** → 200(先把 canEdit 为真证明掉,下面的 403 才有意义)',
    zhaoEditIt.status === 200,
    `实际 ${String(zhaoEditIt.status)}`,
  );
  const zhaoDeleteIt = await api('DELETE', `/nodes/${thresholdId}`);
  check(
    '★ 同一个被授权者**不能删** → 403(删除门槛是 canManage —— 这是 v2.12 唯一的权限收紧)',
    zhaoDeleteIt.status === 403,
    `实际 ${String(zhaoDeleteIt.status)}`,
  );

  // ---- 整棵子树的物理删除 ----
  //
  // 删父节点必须连带删掉子节点,而且**真的读不到了** —— 这是"没有回收站"的核心承诺。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const parentPage = await api('POST', '/nodes', {
    parentId: nodeId('技术部'),
    kind: 'document',
    title: 'I 组的父页面',
  });
  check('建父页面 → 201', parentPage.status === 201, `实际 ${String(parentPage.status)}`);
  const childPage = await api('POST', '/nodes', {
    parentId: parentPage.body?.id,
    kind: 'document',
    title: 'I 组的子页面',
  });
  check('在它下面建子页面 → 201', childPage.status === 201, `实际 ${String(childPage.status)}`);

  const hardDelete = await api('DELETE', `/nodes/${parentPage.body?.id}`);
  check(
    '★ 删除父节点 → 200,removedCount 是**整棵子树**的大小(=2)',
    hardDelete.status === 200 && hardDelete.body?.removedCount === 2,
    `${String(hardDelete.status)} / ${JSON.stringify(hardDelete.body ?? null)}`,
  );
  check(
    '父页面真的读不到了 → 404',
    (await api('GET', `/nodes/${parentPage.body?.id}`)).status === 404,
  );
  check(
    '★ 子页面也一起没了 → 404(整棵子树被物理删除)',
    (await api('GET', `/nodes/${childPage.body?.id}`)).status === 404,
  );

  // ---- 按根的树查询:根不存在 / 不是 uuid ----
  check(
    '按已被删除的节点查子树 → 404(它真的不存在了)',
    (await api('GET', `/org/tree?root=${parentPage.body?.id}`)).status === 404,
  );
  check(
    'root 不是 uuid → 400',
    (await api('GET', '/org/tree?root=abc')).status === 400,
  );

  // ---- 不能删别人的东西 ----
  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const marketDeleteTech = await api('DELETE', `/nodes/${nodeId('技术部')}`);
  check(
    '市场部部长删技术部的节点 → 403',
    marketDeleteTech.status === 403,
    `实际 ${String(marketDeleteTech.status)}`,
  );

  // ---- 收尾:把门槛样本删掉,免得污染后续断言与人工验收 ----
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const cleanupThreshold = await api('DELETE', `/nodes/${thresholdId}`);
  check(
    '收尾:删掉门槛样本 → 200',
    cleanupThreshold.status === 200,
    `实际 ${String(cleanupThreshold.status)}`,
  );

  // 被授权者不能销毁(能改不代表能销毁)。v2.12 起"删除"本身就是销毁,
  // 所以直接验 DELETE —— 旧版这里验的是 /purge 上的 400/403。
  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
  const deletedByGrantee = await api('DELETE', `/nodes/${nodeId('接口规范')}`);
  check(
    '被授权者删「接口规范」→ 403(他在授权名单里,但不在祖先链上)',
    deletedByGrantee.status === 403,
    `实际 ${String(deletedByGrantee.status)}`,
  );

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

  // ⚠️ 先在**本组内自己制造**两个动作:`node.content.update` 与 `org.import`。
  //
  // 原因:审计接口只返回最近 200 条,而这两个动作只有"种子"或日常使用才会产生。
  // 库里跑过几轮验收之后,最早那批就被挤出去了 —— 断言会**莫名其妙地失败**,
  // 而功能一点问题没有(在服务器上实测踩到:本地过、服务器不过)。
  // 依赖"历史记录还在"的断言,迟早会这么坏掉。
  //
  // 顺带把「下载模板 → 原样上传 = 零差异」这条性质在**端到端**层面也验一遍
  // (此前只有单测覆盖)。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  {
    const contentOf = async (title) => {
      const id = nodeId(title);
      const got = await api('GET', `/nodes/${id}/content`);
      return { id, body: got.body };
    };
    const target = await contentOf('接口规范');
    const saved = await api('PUT', `/nodes/${target.id}/content`, {
      content: target.body.content,
      baseUpdatedAt: target.body.updatedAt,
    });
    check('原样保存一次正文 → 200(顺便给审计制造一条 node.content.update)', saved.status === 200);
  }

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  {
    const templateRes = await fetch(`${BASE}/admin/org/import-template`, {
      headers: { Cookie: cookie },
    });
    check('下载组织架构模板 → 200', templateRes.status === 200);
    const templateBuf = Buffer.from(await templateRes.arrayBuffer());

    const makeForm = () => {
      const form = new FormData();
      form.append('file', new Blob([templateBuf]), 'org-import.xlsx');
      return form;
    };

    const preview = await api('POST', '/admin/org/import?dryRun=true', undefined, {
      formData: makeForm(),
    });
    // ⚠️ 用 2xx 而不是 200:Nest 的 POST 默认回 201,写死 200 会假失败。
    check(
      '模板原样上传 → 预览成功',
      preview.status >= 200 && preview.status < 300,
      `实际 ${String(preview.status)}`,
    );
    check(
      '★ 下载模板原样上传 = **零差异**(导入的幂等性)',
      preview.body?.preview?.newUsers?.length === 0 &&
        preview.body?.preview?.newNodes?.length === 0 &&
        preview.body?.preview?.errors?.length === 0,
      `新增人 ${String(preview.body?.preview?.newUsers?.length)} / 新增节点 ${String(preview.body?.preview?.newNodes?.length)} / 错误 ${String(preview.body?.preview?.errors?.length)}`,
    );

    const applied = await api(
      'POST',
      `/admin/org/import?dryRun=false&contentHash=${preview.body.contentHash}`,
      undefined,
      { formData: makeForm() },
    );
    check(
      '确认写入(零差异)→ 2xx,并留下一条 org.import 审计',
      applied.status >= 200 && applied.status < 300,
      `实际 ${String(applied.status)}`,
    );
  }

  const logs = await api('GET', '/audit-logs?limit=200');
  const actions = new Set((logs.body?.items ?? []).map((item) => item.action));
  check('超管能看到审计记录', logs.status === 200 && arr(logs.body?.items).length > 0);
  // ⚠️ v2.14:列表里原本还有 node.restore —— 回收站移除之后那个动作
  // **再也不会发生**,所以这条断言永远失败(跑一次就能看到)。
  // 它不该被「改成另一个还能发生的动作」来凑数,而是直接删掉;
  // 接替它的 visibility.replace 在下面那段保密场景里单独验(那时它才真的发生)。
  for (const action of ['auth.login', 'org.import', 'node.create', 'node.content.update', 'grant.replace', 'node.owner.update', 'comment.create', 'node.delete']) {
    check(`审计里有 ${action}`, actions.has(action));
  }

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
  const zhaoMe = await whoami();
  const zhaoLogs = await api('GET', '/audit-logs?limit=200');
  const zhaoItems = arr(zhaoLogs.body?.items);
  const zhaoActions = new Set(zhaoItems.map((item) => item.action));
  // 她能看到**自己拥有的节点**上的记录(那是她的地盘,应该能看见);
  // 但看不到别人的动作 —— 这才是要验的性质。
  check(
    '赵敏看不到组织架构导入这类与自己无关的记录',
    !zhaoActions.has('org.import'),
    `她看到的动作:${[...zhaoActions].join(', ') || '(无)'}`,
  );

  /*
    ⚠️ 这一条原来只检查"她的日志里有没有 `grant.replace`" —— 那是**错的**,
    而且错得很隐蔽(干净的库里恰好没有反例,所以它一直是绿的)。

    审计的可见性规则是「**我是操作者** 或 目标节点在我的管辖范围内」。
    所以**她自己**成功做过的授权变更,当然应该出现在她的日志里 ——
    那不是"看到了别人的动作"。

    实测踩到:一次崩溃的运行里「后端组」的所有者被改成了赵敏(脚本没还原),
    于是她当时**合法地**改了一次授权,审计如实记下。之后这笔历史一直留在
    最近 200 条里,这一条开始失败 —— 而系统行为完全正确,**错的是断言**。

    要验的性质是「她看不到**别人的**授权变更」,所以按操作者过滤。
    这同时避免了另一个坑:**别让断言的正确性依赖"历史里恰好没有某条记录"**
    (v2.5 已经在审计断言上栽过一次,那次是反过来 —— 让脚本自己制造被断言的动作)。
  */
  const zhaoGrantByOthers = zhaoItems.filter(
    (item) => item.action === 'grant.replace' && item.actor?.id !== zhaoMe?.id,
  );
  check(
    '赵敏看不到**别人的**授权变更(她自己合法做过的除外)',
    zhaoGrantByOthers.length === 0,
    `${String(zhaoGrantByOthers.length)} 条,操作者:${zhaoGrantByOthers.map((x) => x.actor?.name ?? '未知').join('、')}`,
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
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
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

  // ⚠️ 这条断言原来**永远不可能通过**,而它看起来一直在测"离职的人不能被加进组织"。
  //
  // 两个错叠在一起:
  //   1. 改状态(`PATCH /admin/users/:id`)只有**超管**能做,而这里用的是 KC002(部长),
  //      于是那次 PATCH 是 403,KC005 根本没变成离职;
  //   2. 就算她真变成离职了,服务端**先**查组织范围、**后**查在职状态 ——
  //      KC005 属于市场部,不在 KC002 的范围内,所以先撞上 403(超出组织范围),
  //      永远走不到那条 400(不能把权限交给已离职的账号)。
  //
  // 正确做法:① 用超管改状态;② 目标必须**在部长自己的组织范围内**,
  // 否则测的就不是"离职"这条规则。赵敏(KC004)就在技术部/后端组下,拿她当目标。
  const addDeparted = await (async () => {
    cookie = '';
    await login('KC001', [ADMIN_PASSWORD]);
    await api('PATCH', `/admin/users/${userId('KC004')}`, { status: 'departed' });

    cookie = '';
    await login('KC002', [SEED_PASSWORD]);
    const attempt = await api('POST', `/nodes/${nodeId('技术部')}/members`, {
      userId: userId('KC004'),
    });

    cookie = '';
    await login('KC001', [ADMIN_PASSWORD]);
    await api('PATCH', `/admin/users/${userId('KC004')}`, { status: 'active' });

    // 还原成后续断言需要的身份(部长)
    cookie = '';
    await login('KC002', [SEED_PASSWORD]);
    return attempt;
  })();
  check('把已离职的人加进组织 → 400', addDeparted.status === 400, `实际 ${String(addDeparted.status)}`);

  // ============================================================
  // M. 树的按根查询(?root=)
  // ============================================================
  console.log('\nM. 树的按根查询');
  //
  // ⚠️ v2.12 之前这一组还带着"回收站保留策略"的断言(GET /trash/policy、
  // POST /admin/maintenance/trash-purge 的 dryRun 与"刚删的不会被清掉")。
  // 那三个接口随回收站一起删掉了,那些断言一并去掉。
  //
  // **`?root=` 这部分刻意保留** —— 它跟回收站毫无关系,是接口形状的一部分,
  // §11.3 明确要求"不要把接口做成只能返回全部"。
  //
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
    '响应里确实只有那一棵子树的节点(不含它的任何祖先)',
    chenLeaf.body.nodes.some((node) => node.id === nodeId('接口规范')) &&
      !chenLeaf.body.nodes.some((node) => node.title === '技术部') &&
      !chenLeaf.body.nodes.some((node) => node.title === '后端组'),
    `实际 ${String(chenLeaf.body?.nodes?.length ?? 0)} 个:${chenLeaf.body.nodes.map((n) => n.title).join('、')}`,
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
  console.log('\nN. 重置密码(超管),并把演示账号放回原位');
  // ============================================================

  // 这一段有两个职责,**后者比前者重要**。
  //
  // 前者:验「重置密码」这条路 —— 它是"员工忘密码"的唯一正规出口。
  //       没有它,忘密码只能靠运维进容器改数据库(不留痕迹,也不该是运维干的)。
  //
  // 后者:**把演示账号放回文档描述的状态**。A 组为了验首次改密会真的改掉
  //       KC003 的密码,`login()` 这个辅助函数也会顺手改掉 KC004 ——
  //       而这件事以前**没有任何地方还原**。
  //
  //       后果有两条,都是真的踩过:
  //         · 跑过一次验收之后,`DEMO-ACCOUNTS.txt` 里写的 123456 就登不上了
  //           (用户反馈过一句「测试账号没了?」)
  //         · 下一轮 A 组会走"跳过"分支,总项数从 143 掉到 136 ——
  //           看着像回归,其实是上一轮脚本自己造成的
  //
  //       所以这一段是**幂等性的前提**:跑完它,再跑一次的结果与第一次完全一致。

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const roster = await api('GET', '/admin/users?limit=500');

  check('超管能拿到人员名册', roster.status === 200 && Array.isArray(roster.body?.users));
  // v2.13 之前这里只要 Array.isArray(body)。现在是包装对象,**必须验 total** ——
  // 没有 total 的话"我只看到了一部分"这件事在界面上是无法判断的
  // (而这正是它此前静默截断 200 条却没人发现的原因)。
  check(
    '名册带 total 与 nextCursor(截断可见)',
    typeof roster.body?.total === 'number' && roster.body.total >= roster.body.users.length,
    `total=${String(roster.body?.total)} users=${String(roster.body?.users?.length)}`,
  );

  // 真去翻一页:limit=2 时必须只回 2 条、且给出游标;而 total 不受 limit 影响。
  const paged = await api('GET', '/admin/users?limit=2');
  const pageTwo = await api('GET', `/admin/users?limit=2&cursor=${encodeURIComponent(paged.body?.nextCursor ?? '')}`);
  check(
    'limit 生效,且游标能翻到下一页且不重复',
    paged.body?.users?.length === 2 &&
      typeof paged.body?.nextCursor === 'string' &&
      pageTwo.body?.users?.length >= 1 &&
      !pageTwo.body.users.some((u) => u.employeeNo === paged.body.users[0]?.employeeNo),
    `p1=${String(paged.body?.users?.length)} cursor=${String(paged.body?.nextCursor)} p2=${String(pageTwo.body?.users?.length)}`,
  );
  check(
    'total 不受 limit 影响',
    paged.body?.total === roster.body?.total,
    `limit2=${String(paged.body?.total)} full=${String(roster.body?.total)}`,
  );
  const byNo = new Map((roster.body?.users ?? []).map((item) => [item.employeeNo, item]));
  const kc001 = byNo.get('KC001');
  const kc003 = byNo.get('KC003');
  const kc004 = byNo.get('KC004');
  const kc005 = byNo.get('KC005');

  check(
    '名册带 mustChangePassword(界面靠它标「初始密码未改」)',
    typeof kc003?.mustChangePassword === 'boolean',
    `实际 ${typeof kc003?.mustChangePassword}`,
  );
  check(
    '名册带账号状态(离职的人要能看出来)',
    typeof kc005?.status === 'string',
    `实际 ${String(kc005?.status)}`,
  );

  // ---- 判权:名册与重置都是超管专属 ----
  //
  // ⚠️ 名册此前**根本没有判权** —— 任何登录用户都能拿到全公司名册,
  // 而文档一直写的是超管。是加 `mustChangePassword` 的时候才暴露的:
  // 那个字段等于一份"谁的密码还是 123456"的目标清单。
  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  check('非超管读人员名册 → 403', (await api('GET', '/admin/users?limit=500')).status === 403);
  const outsiderReset = await api(
    'POST',
    `/admin/users/${String(kc004?.id)}/reset-password`,
    {},
  );
  check(
    '非超管重置别人的密码 → 403',
    outsiderReset.status === 403,
    `实际 ${String(outsiderReset.status)}`,
  );

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const selfReset = await api('POST', `/admin/users/${String(kc001?.id)}/reset-password`, {});
  check(
    '重置**自己**的密码 → 400(能登进来的人不需要,允许只会制造一次手滑)',
    selfReset.status === 400,
    `实际 ${String(selfReset.status)}`,
  );

  // ---- 重置会**吊销他手上的会话** ----
  //
  // 这是这个动作最容易漏掉、也最容易让人误解的一半:管理员说"我把他密码重置了",
  // 心里想的是"我把他踢出去了"。不删会话行的话,他那个标签页还能继续用。
  cookie = '';
  const kc004Alive = await tryLogin('KC004', [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
  const kc004Cookie = cookie;
  check('KC004 重置前能正常登录(后面要验这个会话会被吊销)', kc004Alive && kc004Cookie !== '');
  check(
    '重置前,他带会话能读树',
    (await api('GET', '/org/tree')).status === 200,
  );

  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const resetKc004 = await api('POST', `/admin/users/${String(kc004?.id)}/reset-password`, {});
  check(
    '超管重置 KC004 的密码 → 200',
    resetKc004.status === 200,
    `实际 ${String(resetKc004.status)}`,
  );
  check(
    '响应里 mustChangePassword 已经变成 true',
    resetKc004.body?.mustChangePassword === true,
    JSON.stringify(resetKc004.body ?? null).slice(0, 120),
  );

  cookie = kc004Cookie;
  check(
    '★ 重置之后他**原来的会话立刻失效** → 401(不然"重置了"只是句空话)',
    (await api('GET', '/org/tree')).status === 401,
  );

  // ---- 重置之后:他还是得走完整条首登链路 ----
  cookie = '';
  const afterReset = await api('POST', '/auth/login', {
    employeeNo: 'KC004',
    password: INITIAL_PASSWORD,
  });
  check(
    '重置后用初始密码登录 → kind = password-change-required',
    afterReset.status === 200 && afterReset.body?.kind === 'password-change-required',
    JSON.stringify(afterReset.body ?? null).slice(0, 120),
  );
  check(
    '★ 重置仍然**不下发会话** —— 重置没有把"首登不建会话"这条规矩绕过去',
    !issuedSession(afterReset),
    `Set-Cookie: ${afterReset.setCookie.join(' | ') || '(空)'}`,
  );

  // ---- 把 KC003 / KC004 放回演示状态 ----
  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  const restoreKc003 = await api('POST', `/admin/users/${String(kc003?.id)}/reset-password`, {});
  check(
    '把 KC003 也放回「初始密码 + 待首次登录」',
    restoreKc003.status === 200 && restoreKc003.body?.mustChangePassword === true,
    `实际 ${String(restoreKc003.status)}`,
  );

  cookie = '';
  const demoCheck = await api('POST', '/auth/login', {
    employeeNo: 'KC003',
    password: INITIAL_PASSWORD,
  });
  check(
    '★ 演示账号回到文档描述的状态:KC003 / 123456 能走到「要改密」这一步',
    demoCheck.status === 200 && demoCheck.body?.kind === 'password-change-required',
    `实际 ${String(demoCheck.status)} ${JSON.stringify(demoCheck.body ?? null).slice(0, 100)}`,
  );

  // ---- 重置一个登不进来的人是白做工,要说清原因 ----
  cookie = '';
  await login('KC001', [ADMIN_PASSWORD]);
  await api('PATCH', `/admin/users/${String(kc005?.id)}`, { status: 'departed' });
  const resetDeparted = await api('POST', `/admin/users/${String(kc005?.id)}/reset-password`, {});
  check(
    '重置「已离职」的人 → 400,并且提示要先把状态改回在职',
    resetDeparted.status === 400 &&
      typeof resetDeparted.body?.error?.message === 'string' &&
      resetDeparted.body.error.message.includes('在职'),
    `${String(resetDeparted.status)} ${JSON.stringify(resetDeparted.body ?? null).slice(0, 120)}`,
  );
  // 复原。**必须复原** —— 否则演示数据里会多一个离职的市场部部长。
  await api('PATCH', `/admin/users/${String(kc005?.id)}`, { status: 'active' });
  const kc005Back = await api('GET', '/admin/users?limit=500');
  check(
    '复原 KC005 为在职(验收不能留下改动)',
    (kc005Back.body?.users ?? []).find((item) => item.employeeNo === 'KC005')?.status === 'active',
  );


  // ============================================================
  // 保密能力(v2.13)—— 受限节点与读者名单
  // ============================================================
  //
  // 这一段必须自己复原(把 市场部 改回公开),否则后面的收尾与下一轮运行的
  // 断言都会看到一个受限的市场部 —— 那是"验收脚本把演示数据弄脏"的老毛病。
  {
    const MARKET = nodeId("市场部");
    const kc004Id = userId("KC004");

    await login("KC001", [ADMIN_PASSWORD]);
    const before = await api("GET", "/nodes/" + String(MARKET) + "/readers");
    check(
      "默认可见性是 public(存量数据行为不变)",
      before.status === 200 && before.body?.visibility === "public",
      String(before.status) + " " + String(before.body?.visibility),
    );

    // 1) 改成受限,名单为空
    const setRestricted = await api("PUT", "/nodes/" + String(MARKET) + "/readers", {
      version: before.body?.version,
      visibility: "restricted",
      userIds: [],
    });
    check("超管能把节点改成受限 → 200", setRestricted.status === 200, String(setRestricted.status));

    // 2) 无关的人(赵敏,技术部)看不见了 —— 树 / 详情 / 正文 / 导出 / 检索全都要挡住
    await login("KC004", [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
    const treeHidden = await api("GET", "/org/tree");
    const visibleTitles = (treeHidden.body?.nodes ?? []).map((n) => n.title);
    check(
      "★ 受限节点的整棵子树从树里消失(连子节点标题一起)",
      treeHidden.status === 200 &&
        !visibleTitles.includes("市场部") &&
        !visibleTitles.includes("市场部工作方式"),
      "市场部=" + String(visibleTitles.includes("市场部")) +
        " 子节点=" + String(visibleTitles.includes("市场部工作方式")),
    );

    const detailHidden = await api("GET", "/nodes/" + String(MARKET));
    check(
      "★ 读不到时回 404 而不是 403(403 等于承认这里有个你看不见的东西)",
      detailHidden.status === 404,
      String(detailHidden.status),
    );

    const contentHidden = await api("GET", "/nodes/" + String(MARKET) + "/content");
    check("★ 正文也读不到 → 404", contentHidden.status === 404, String(contentHidden.status));

    const exportHidden = await api("GET", "/nodes/" + String(MARKET) + "/export?format=md");
    check(
      "★ 导出也读不到 → 404(漏了就能整篇下载走)",
      exportHidden.status === 404,
      String(exportHidden.status),
    );

    const searchHidden = await api("GET", "/search?q=" + encodeURIComponent("市场部工作方式"));
    check(
      "★ 检索里也搜不到(最容易漏的一条读取路径)",
      searchHidden.status === 200 &&
        !(searchHidden.body?.hits ?? []).some((h) => h.nodeId === MARKET),
      "hits=" + String((searchHidden.body?.hits ?? []).length),
    );

    // 3) 所有者链仍然看得见 —— 受限不是"谁都看不见"
    await login("KC005", [SEED_PASSWORD, ADMIN_PASSWORD]);
    const ownerSees = await api("GET", "/nodes/" + String(MARKET));
    check(
      "★ 市场部部长的所有者链仍然看得见(受限不等于谁都看不见)",
      ownerSees.status === 200,
      String(ownerSees.status),
    );

    // 4) 非创建者、非所有者改不了可见范围
    //
    // ⚠️ 先作为作者读一下当前 version,再拿它去改 —— 否则会撞上乐观锁。
    // 第一版这里写的是 `version: 1`(拍脑袋的数字),于是版本检查**先于**权限检查
    // 触发,拿到 409 而不是 403/404。
    // 那看起来像"权限没挡住",实际上是这条断言**根本没测到权限** ——
    // 一条测错了对象的断言比没有断言更坏,因为它给人已经验证过的错觉。
    await login("KC004", [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
    const asZhao = await api("GET", "/nodes/" + String(MARKET) + "/readers");
    const forbidden = await api("PUT", "/nodes/" + String(MARKET) + "/readers", {
      version: asZhao.body?.version ?? 1,
      visibility: "public",
      userIds: [],
    });
    check(
      "★ 无关的人改可见范围 → 403 或 404(两者都算挡住)",
      forbidden.status === 403 || forbidden.status === 404,
      String(forbidden.status),
    );

    // 4.5) ★ 侧信道:受限节点上**每一条**读接口都必须回 404,一条都不能漏。
    //
    // v2.15 文档对账时实测发现两条漏的:
    //   · GET /nodes/:id/members  —— 用的是 chainOf,不判可见性,返回 200
    //   · GET /nodes/:id/readers  —— 直接查名单,**把保密名单本身读走了**
    // 其余(详情/正文/导出/评论/授权名单)都正确地回 404。
    // 一条不一致的读路径就是一条侧信道:它确认节点存在,还可能带出内容。
    {
      for (const [label, path] of [
        ["详情", `/nodes/${String(MARKET)}`],
        ["正文", `/nodes/${String(MARKET)}/content`],
        ["导出", `/nodes/${String(MARKET)}/export?format=md`],
        ["评论", `/nodes/${String(MARKET)}/comments`],
        ["授权名单", `/nodes/${String(MARKET)}/grants`],
        ["可见范围", `/nodes/${String(MARKET)}/readers`],
        ["成员列表", `/nodes/${String(MARKET)}/members`],
      ]) {
        const probe = await api("GET", path);
        check(
          `★ 受限节点的「${label}」对无关的人回 404(不能有侧信道)`,
          probe.status === 404,
          `实际 ${String(probe.status)}`,
        );
      }
    }

    // 5) 把赵敏加进读者名单 → 她又能看到了
    await login("KC001", [ADMIN_PASSWORD]);
    const nowRestricted = await api("GET", "/nodes/" + String(MARKET) + "/readers");
    const addReader = await api("PUT", "/nodes/" + String(MARKET) + "/readers", {
      version: nowRestricted.body?.version,
      visibility: "restricted",
      userIds: [kc004Id],
    });
    check(
      "加进读者名单 → 200 且名单里有她",
      addReader.status === 200 &&
        (addReader.body?.readers ?? []).some((r) => r.userId === kc004Id),
      JSON.stringify((addReader.body?.readers ?? []).map((r) => r.userId)),
    );

    await login("KC004", [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
    const readerSees = await api("GET", "/nodes/" + String(MARKET));
    check("★ 名单里的人读得到 → 200", readerSees.status === 200, String(readerSees.status));

    const readerTree = await api("GET", "/org/tree");
    check(
      "★ 树里也回来了",
      (readerTree.body?.nodes ?? []).some((n) => n.title === "市场部"),
      "nodes=" + String((readerTree.body?.nodes ?? []).length),
    );

    // 6) 复原成公开 —— 必须复原,否则演示数据里市场部会一直是受限的
    await login("KC001", [ADMIN_PASSWORD]);
    const back = await api("GET", "/nodes/" + String(MARKET) + "/readers");
    const restored = await api("PUT", "/nodes/" + String(MARKET) + "/readers", {
      version: back.body?.version,
      visibility: "public",
      userIds: [],
    });
    check(
      "复原为公开(验收不能留下改动)",
      restored.status === 200 && restored.body?.visibility === "public",
      String(restored.body?.visibility),
    );

    await login("KC004", [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
    const openAgain = await api("GET", "/nodes/" + String(MARKET));
    check(
      "改回公开之后名单外的人也读得到(名单不再是门槛)",
      openAgain.status === 200,
      String(openAgain.status),
    );

    // 可见性变更必须留痕,顺便验 action 筛选真的能筛(服务端筛,不是客户端)
    await login("KC001", [ADMIN_PASSWORD]);
    const visLogs = await api("GET", "/audit-logs?limit=200&action=visibility.replace");
    const visItems = visLogs.body?.items ?? [];
    check(
      "★ 可见性变更进了审计,且 action 筛选生效",
      visLogs.status === 200 &&
        visItems.length > 0 &&
        visItems.every((item) => item.action === "visibility.replace"),
      "status=" + String(visLogs.status) + " items=" + String(visItems.length),
    );

    // 导出必须与列表**同一个可见范围** —— 导出若绕开范围就是一次越权读取,
    // 而"页面上看不到、导出文件里全有"这种事没有任何地方会报错。
    // ⚠️ 必须读 `.text`(原始响应体),不能读 `.body`:
    // `body` 是 JSON.parse 之后的结果,对 text/csv 永远是 null ——
    // 于是"带 BOM 吗"这条断言**必然为假**。这是脚本自己的 bug,
    // 而它看起来像是导出功能坏了(真机部署时就是这么误报的)。
    const csvSuper = await api("GET", "/audit-logs/export");
    const csvScoped = await api("GET", "/audit-logs/export?action=visibility.replace");
    // (BOM 不再作为常量比较 —— 见下面:直接查字节 0xEF 0xBB 0xBF,因为 text 解码可能吃掉它)
    check(
      "★ 审计导出为 CSV,且带 BOM(Excel 打开不乱码)",
      csvSuper.status === 200 &&
        // BOM 必须查**字节**:text 经过解码可能已经被规范吃掉
        csvSuper.bytes[0] === 0xef &&
        csvSuper.bytes[1] === 0xbb &&
        csvSuper.bytes[2] === 0xbf &&
        csvSuper.text.includes("时间,操作者"),
      "status=" + String(csvSuper.status) +
        " bom=" + String(csvSuper.bytes[0] === 0xef && csvSuper.bytes[1] === 0xbb && csvSuper.bytes[2] === 0xbf),
    );
    check(
      "★ 导出带上筛选条件时只剩那一类动作",
      csvScoped.status === 200 &&
        csvScoped.text.includes("修改可见范围") &&
        !csvScoped.text.includes("登录"),
      "status=" + String(csvScoped.status),
    );

    // ★ 换一个范围小得多的人:他导出的文件里**不该出现**超管那条 visibility.replace
    await login("KC004", [SEED_PASSWORD, INITIAL_PASSWORD, ADMIN_PASSWORD]);
    const csvZhao = await api("GET", "/audit-logs/export");
    check(
      "★★ 导出遵守可见范围(赵敏导不出市场部那条记录)",
      csvZhao.status === 200 &&
        !csvZhao.text.includes("修改可见范围"),
      "status=" + String(csvZhao.status),
    );
  }
  // ---- 收尾:把脚本动过的**全部**东西放回去 ----
  //
  // v2.6 这里只还原了**密码**,结果服务器上还是越跑越脏:脚本建出来的测试节点
  // 在崩掉的那一轮留在了库里,「后端组」的所有者也被改成了赵敏 ——
  // 于是下一次运行时 C 组的断言开始失败,看起来像"组长改不动内容了"。
  //
  // v2.7 起统一交给 `restoreToolState()`:密码 + 残留节点 + 被改的所有者。
  // 异常时文件末尾的 `finally` 还会再兜一次。
  console.log('  · 收尾还原(密码 / 残留节点 / 所有者):');
  for (const note of await restoreToolState()) console.log(`    · ${note}`);
  restoredByScript = true;

  // ============================================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`通过 ${String(passed)} 项,失败 ${String(failed)} 项`);
  if (failed > 0) process.exit(1);
  console.log('✅ v2.0 权限模型端到端验收全部通过');
}

/*
  ⚠️ `finally` 里再兜一次还原。

  这一条也是被实测逼出来的:脚本中途抛异常时,**中间那些 `check()` 的结果全丢了**
  (连汇总都打不出来),而更要紧的是**收尾还原不会跑** —— 于是库里又多一批垃圾,
  下一轮失败得更厉害,恶性循环。

  这里只兜"还原",不兜"异常本身":异常照旧抛出去(退出码仍是 1),
  因为"脚本自己崩了"和"某条断言没过"是两件不同的事,不该混成同一个信号。
*/
try {
  await main();
} finally {
  if (!restoredByScript) {
    console.log('\n收尾还原(脚本异常退出,这是兜底):');
    for (const note of await restoreToolState()) console.log(`  · ${note}`);
  }
}

// zz probe marker
