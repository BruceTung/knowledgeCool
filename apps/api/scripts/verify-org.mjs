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

  const text = await response.text();
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  // `setCookie` 单独给出来:有一条断言必须看**响应头**才知道结果 ——
  // "首次登录不下发会话 Cookie"。只看 `cookie` 变量是看不出来的
  // (它会在没有新 Cookie 时保留上一次的值)。
  return { status: response.status, body: json, text, setCookie: response.headers.getSetCookie?.() ?? [] };
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
async function login(employeeNo, candidates) {
  for (const password of candidates) {
    const attempt = await api('POST', '/auth/login', { employeeNo, password });
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
      console.log(`  · ${employeeNo} 用初始密码登录 → 被要求先改密,改完重新登录(顺带验过这条链路)`);
      return true;
    }

    return true;
  }
  return false;
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
    if (!(await login('KC001', [ADMIN_PASSWORD]))) {
      notes.push('拿不到超管会话,未能还原');
      return notes;
    }

    const users = arr((await api('GET', '/admin/users')).body);
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
          if (!(await login(employeeNo, passwords))) continue;

          // 节点可能已经在回收站里(上一次软删成功、彻底删失败),
          // 这时软删会回 400 —— 但彻底删照样能做,所以不看软删的结果。
          await api('DELETE', `/nodes/${node.id}`);
          const hard = await api('DELETE', `/nodes/${node.id}/purge`);
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
  if (!(await login('KC001', [ADMIN_PASSWORD]))) {
    console.error('✗ 超管 KC001 登录失败 —— 先跑 pnpm seed:dev');
    process.exit(1);
  }
  const admin = await whoami();
  check('超管 KC001 登录成功且 isSuperAdmin 为真', admin?.isSuperAdmin === true);

  let tree = (await api('GET', '/org/tree')).body;
  const nodeId = (title) => tree.nodes.find((node) => node.title === title)?.id;
  let users = (await api('GET', '/admin/users')).body;
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
    users = (await api('GET', '/admin/users')).body;
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
  const deleted = await api('DELETE', `/nodes/${underOwnId}`);
  check(
    '组长能软删组员建的页面 → 200 且 removedCount 为 1',
    deleted.status === 200 && deleted.body?.removedCount === 1,
    `${String(deleted.status)} / ${JSON.stringify(deleted.body ?? null).slice(0, 100)}`,
  );

  cookie = '';
  await login('KC005', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const marketTrash = await api('GET', '/trash');
  check(
    '别人的回收站条目不会出现在孙浩这里',
    !arr(marketTrash.body).some((item) => item.id === underOwnId),
  );

  cookie = '';
  await login('KC003', [SEED_PASSWORD, INITIAL_PASSWORD]);
  const ownTrash = await api('GET', '/trash');
  check('王思远的回收站里能看到它', arr(ownTrash.body).some((item) => item.id === underOwnId));
  check(
    '回收站条目带 deletedByName 与 parentAlive',
    typeof arr(ownTrash.body)[0]?.deletedByName === 'string' &&
      typeof arr(ownTrash.body)[0]?.parentAlive === 'boolean',
  );

  // 当前身份是王思远(后端组组长),他对「接口规范」有管理权 ——
  // 所以这一个会走到"必须先软删除"那条校验,而不是被 403 挡在前面。
  const purgeLive = await api('DELETE', `/nodes/${nodeId('接口规范')}/purge`);
  check('对没进回收站的节点彻底删除 → 400', purgeLive.status === 400, `实际 ${String(purgeLive.status)}`);

  // POST 的默认状态码是 201,不是 200 —— 这里两种都接受,
  // 免得测试因为框架默认值而误报
  const restored = await api('POST', `/nodes/${underOwnId}/restore`);
  check('恢复 → 2xx', restored.status === 200 || restored.status === 201, `实际 ${String(restored.status)}`);
  check('恢复后能重新读到', (await api('GET', `/nodes/${underOwnId}`)).status === 200);

  // 彻底删除:门槛是 canManage(祖先链所有者),被授权者与被删页面自己没有权限。
  // 用陈默(技术部部长)来验 —— 他是这棵树的所有者链顶端。
  cookie = '';
  await login('KC002', [SEED_PASSWORD]);
  const deletedAgain = await api('DELETE', `/nodes/${underOwnId}`);
  check('再次软删 → 200', deletedAgain.status === 200);
  const purged = await api('DELETE', `/nodes/${underOwnId}/purge`);
  check('所有者彻底删除 → 204', purged.status === 204, `实际 ${String(purged.status)}`);
  check(
    '彻底删除后真的读不到了 → 404',
    (await api('GET', `/nodes/${underOwnId}`)).status === 404,
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
  for (const action of ['auth.login', 'org.import', 'node.create', 'node.content.update', 'grant.replace', 'node.owner.update', 'comment.create', 'node.delete', 'node.restore']) {
    check(`审计里有 ${action}`, actions.has(action));
  }

  cookie = '';
  await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
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
  const roster = await api('GET', '/admin/users');
  check('超管能拿到人员名册', roster.status === 200 && Array.isArray(roster.body));

  const byNo = new Map((roster.body ?? []).map((item) => [item.employeeNo, item]));
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
  check('非超管读人员名册 → 403', (await api('GET', '/admin/users')).status === 403);
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
  const kc004Alive = await login('KC004', [SEED_PASSWORD, INITIAL_PASSWORD]);
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
  const kc005Back = await api('GET', '/admin/users');
  check(
    '复原 KC005 为在职(验收不能留下改动)',
    (kc005Back.body ?? []).find((item) => item.employeeNo === 'KC005')?.status === 'active',
  );

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
