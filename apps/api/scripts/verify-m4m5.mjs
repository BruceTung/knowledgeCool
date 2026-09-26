/**
 * M4 + M5 端到端验收(DESIGN.md §9.1 引用的就是这个脚本)。
 *
 * 用法(先 `docker compose up -d && pnpm seed:dev`):
 *   pnpm verify:m4m5
 *   # 或指向别的实例:
 *   KC_API=http://主机:8080/api/v1 KC_ROOT=http://主机:8080 KC_SEED_PASSWORD=xxx \
 *     node apps/api/scripts/verify-m4m5.mjs
 *
 * 覆盖两类断言:
 *   A. **正向**:正文往返、中文检索、评论、权限规则、审计、导出、上传。
 *   B. **失败路径**(比正向更重要):越权一定被拒,而且拒绝的**形状**要对
 *      —— 该 404 的不能是 403,该 409 的不能静默覆盖。
 *
 * 脚本会**自己还原**它改动的东西(正文写完还原、权限规则改完改回、评论删掉),
 * 所以可以反复运行,不会把演示数据跑坏。
 */
const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
const ROOT = process.env.KC_ROOT ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (extra === '' ? '' : `  →  ${extra}`));
    console.log(`  ✗ ${name}${extra === '' ? '' : `  →  ${extra}`}`);
  }
}

let cookie = '';

/**
 * 被脚本改动、需要在最后还原的东西。
 *
 * 「技术方案」的正文在 A 组被覆盖成测试内容,而 B 组要搜的正是那段内容 ——
 * 所以还原必须放在**所有断言跑完之后**,不能放在 A 组末尾。
 * 还原之后脚本就可以反复运行,不会把演示数据跑坏。
 */
let original = null;
let originalBase = null;

function syncCookie(res) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('\n')
      : (res.headers.get('set-cookie') ?? '');
  const matched = /kc_session=([^;]*)/.exec(raw);
  if (matched !== null) cookie = matched[1] === '' ? '' : `kc_session=${matched[1]}`;
}

async function raw(method, url, init = {}) {
  const res = await fetch(url, {
    method,
    ...init,
    headers: { ...(cookie === '' ? {} : { Cookie: cookie }), ...(init.headers ?? {}) },
  });
  syncCookie(res);
  return res;
}

async function api(method, path, body) {
  const res = await raw(method, `${BASE}${path}`, {
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // 两条路径(try 成功 / catch)都会赋值,所以不写初始值
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, contentType: res.headers.get('content-type') ?? '' };
}

async function loginAs(email) {
  cookie = '';
  const res = await api('POST', '/auth/login', { email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`登录失败 ${email}: ${String(res.status)}`);
}

/** 递归排序 key 后的 JSON —— 比较 jsonb 往返是否语义一致(key 顺序会被重排)。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const doc = (...content) => ({ type: 'doc', content });
const p = (value) => ({ type: 'paragraph', content: value === '' ? [] : [{ type: 'text', text: value }] });
const h = (level, value) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: value }] });

/** 从页面树里按标题找节点(递归)。 */
function findNode(nodes, title) {
  for (const node of nodes) {
    if (node.title === title) return node;
    const inner = findNode(node.children ?? [], title);
    if (inner !== null) return inner;
  }
  return null;
}

async function main() {
  console.log(`接口: ${BASE}\n`);

  // ================================================================
  // 准备:找出场景里需要的页面 id
  // ================================================================
  await loginAs('admin@example.com');
  const spaces = await api('GET', '/spaces');
  // GET /spaces 直接返回数组(SpaceSummary[]),不是 { spaces: [...] }
  const dev = (spaces.body ?? []).find((s) => s.name === '研发中心');
  if (dev === undefined) throw new Error('找不到「研发中心」—— 种子数据没跑?');

  const tree = await api('GET', `/spaces/${dev.id}/pages`);
  const spec = findNode(tree.body.nodes, '需求规格说明书');
  const tech = findNode(tree.body.nodes, '技术方案');
  const permModel = findNode(tree.body.nodes, '权限模型');
  const apiConvention = findNode(tree.body.nodes, '接口设计约定');
  if (spec === null || tech === null || permModel === null || apiConvention === null) {
    throw new Error('页面树里缺少种子页面');
  }

  // ================================================================
  // A. 正文(M4)
  // ================================================================
  console.log('\n【A. 正文存取】');
  {
    const res = await api('GET', `/pages/${tech.id}/content`);
    const types = (res.body?.content?.content ?? []).map((n) => n.type);
    check('取正文 → 200 且是 ProseMirror 文档树', res.status === 200 && res.body.content.type === 'doc');
    check('正文里真的有内容(不是空文档)', types.length > 5, `节点数=${String(types.length)}`);
    check(
      '正文带表格节点 —— 表格内容也能被搜到',
      JSON.stringify(res.body.content).includes('"type":"table"'),
    );

    // ⚠️ 记住原文:下面的往返测试会覆盖它,整段跑完要还原。
    // 不还原的话,这个脚本跑第二次时前两条断言必然失败 —— 脚本不该破坏演示数据。
    // 还原放在**最后**(见末尾「还原」一节),因为后面的检索断言依赖刚写进去的内容。
    original = res.body.content;

    // 往返:写进去再读出来必须一致
    const payload = doc(
      h(1, '技术方案'),
      p('这一行是新写入的,用来验证往返一致性与检索同步。关键词:架构决策记录。'),
    );
    const saved = await api('PUT', `/pages/${tech.id}/content`, { content: payload });
    check('保存正文 → 200', saved.status === 200);
    check('保存后 updatedAt 有值', typeof saved.body?.updatedAt === 'string');

    const reread = await api('GET', `/pages/${tech.id}/content`);
    // ⚠️ 不能比 JSON.stringify 的原始输出:PostgreSQL 的 jsonb **不保留 key 顺序**,
    // 写进去的顺序读回来会变。要比语义 —— 递归排序 key 之后再比。
    check(
      '写进去再读出来内容一致(语义无损;jsonb 会重排 key,所以按规范序比)',
      canonical(reread.body.content) === canonical(payload),
    );
    check(
      '读回来的结构仍是合法文档树',
      reread.body.content.type === 'doc' && Array.isArray(reread.body.content.content),
    );

    // 冲突:用已过期的 baseUpdatedAt 再写一次 → 409
    const stale = await api('PUT', `/pages/${tech.id}/content`, {
      content: doc(p('基于旧版本写入')),
      baseUpdatedAt: '2020-01-01T00:00:00.000Z',
    });
    check('用过期 baseUpdatedAt 保存 → 409 而不是静默覆盖', stale.status === 409, `实际 ${String(stale.status)}`);

    // 非法结构 → 400
    const bad = await api('PUT', `/pages/${tech.id}/content`, { content: { type: 'not-doc' } });
    check('非法文档结构 → 400', bad.status === 400, `实际 ${String(bad.status)}`);

    // 正文超大 → 400
    const huge = await api('PUT', `/pages/${tech.id}/content`, {
      content: doc(p('字'.repeat(2_200_000))),
    });
    check('正文超过 2MB → 400(而不是把库撑爆)', huge.status === 400, `实际 ${String(huge.status)}`);

    // 记下这次保存后的时间戳,留给最后还原用
    originalBase = saved.body.updatedAt;
  }

  // ================================================================
  // B. 检索(M4)
  // ================================================================
  console.log('\n【B. 中文检索】');
  {
    await loginAs('editor@example.com');

    const zh = await api('GET', `/search?q=${encodeURIComponent('权限')}`);
    const zhIds = (zh.body?.hits ?? []).map((hit) => hit.pageId);
    check('搜「权限」有命中(中文子串检索可用)', zh.body.hits.length > 0, `命中 ${String(zh.body.hits.length)} 条`);
    check('命中包含标题为「权限模型」的页面', zhIds.includes(permModel.id));

    const en = await api('GET', `/search?q=${encodeURIComponent('架构决策记录')}`);
    check(
      '搜刚写进正文的词也能命中(落库时同步抽了纯文本)',
      en.body.hits.some((hit) => hit.pageId === tech.id),
      `命中 ${String(en.body.hits.length)} 条`,
    );

    const titleHit = await api('GET', `/search?q=${encodeURIComponent('新人手册')}`);
    check(
      '标题命中被标记为 matchedIn=title',
      titleHit.body.hits[0]?.matchedIn === 'title',
      `实际 ${String(titleHit.body.hits[0]?.matchedIn)}`,
    );

    const empty = await api('GET', '/search?q=');
    check('空关键词 → 空结果而不是报错', empty.status === 200 && empty.body.hits.length === 0);

    const wildcard = await api('GET', `/search?q=${encodeURIComponent('%')}`);
    check(
      '搜「%」不会命中所有内容(LIKE 通配符已转义)',
      wildcard.body.hits.length === 0,
      `命中 ${String(wildcard.body.hits.length)} 条`,
    );

    const long = await api('GET', `/search?q=${'a'.repeat(200)}`);
    check('超长关键词 → 400', long.status === 400, `实际 ${String(long.status)}`);
  }

  // ================================================================
  // C. 权限:树过滤 / 正文越权 / deny 短路(M5)
  // ================================================================
  console.log('\n【C. 页面级权限】');
  {
    await loginAs('viewer@example.com');

    const viewerTree = await api('GET', `/spaces/${dev.id}/pages`);
    const viewerSeesTech = findNode(viewerTree.body.nodes, '技术方案') !== null;
    const viewerSeesApi = findNode(viewerTree.body.nodes, '接口设计约定') !== null;
    check('被 deny 的页面从树里消失(不是灰显)', !viewerSeesTech);
    check(
      '⚠️ 子页面写了 allow 也翻不了父页面的 deny(拒绝优先会短路)',
      !viewerSeesApi,
      viewerSeesApi ? '子页面仍然可见 —— 短路没生效' : '',
    );

    const viewerContent = await api('GET', `/pages/${tech.id}/content`);
    check('只读成员读被 deny 的正文 → 404(最小可见,不是 403)', viewerContent.status === 404, `实际 ${String(viewerContent.status)}`);

    const viewerWrite = await api('PUT', `/pages/${tech.id}/content`, { content: doc(p('越权写入')) });
    check('只读成员写正文 → 被拒', viewerWrite.status === 404 || viewerWrite.status === 403, `实际 ${String(viewerWrite.status)}`);

    const viewerCanReadSpec = await api('GET', `/pages/${spec.id}/content`);
    check('只读成员读正常页面 → 200', viewerCanReadSpec.status === 200);

    const viewerWriteSpec = await api('PUT', `/pages/${spec.id}/content`, { content: doc(p('越权写入')) });
    check('只读成员写正常页面 → 403', viewerWriteSpec.status === 403, `实际 ${String(viewerWriteSpec.status)}`);

    const viewerPerms = await api('GET', `/pages/${spec.id}/permissions`);
    check('只读成员可以看权限推导链(不然不知道自己为什么没权限)', viewerPerms.status === 200);

    const viewerSavePerms = await api('PUT', `/pages/${spec.id}/permissions`, { rules: [] });
    check('只读成员改权限 → 403', viewerSavePerms.status === 403, `实际 ${String(viewerSavePerms.status)}`);

    // 检索也必须过滤 —— 这是最容易被漏掉的一处泄露
    const viewerSearch = await api('GET', `/search?q=${encodeURIComponent('架构决策记录')}`);
    check(
      '⚠️ 检索结果按权限过滤 —— 搜不到被 deny 的正文',
      !(viewerSearch.body?.hits ?? []).some((hit) => hit.pageId === tech.id),
      `命中 ${String(viewerSearch.body?.hits?.length ?? -1)} 条`,
    );
  }

  // ================================================================
  // D. 权限规则读写与推导链(M5)
  // ================================================================
  console.log('\n【D. 权限规则与推导链】');
  {
    await loginAs('admin@example.com');

    const before = await api('GET', `/pages/${tech.id}/permissions`);
    check('管理员能读推导链', before.status === 200);
    // 推导链解释的是**我**的有效权限,不是所有人的。
    // 赵敏的 deny 规则对管理员不命中,所以管理员的链上没有 deny 那一环 ——
    // 这是刻意的语义,不是一个漏做的功能。
    check(
      '推导链只反映「我的」权限 —— 别人被 deny 不会出现在我的链上',
      (before.body.chain ?? []).every((step) => step.source !== 'deny'),
    );
    check('推导链的结论与 myRole 一致(管理员走空间兜底)', before.body.myRole === 'admin');
    check(
      '推导链从根到自身(根页面 → 链只有它自己)',
      (before.body.chain ?? []).length === 1 && before.body.chain[0].pageId === tech.id,
    );
    check('本页显式规则里有那条 deny', (before.body.rules ?? []).some((rule) => rule.deny === true));
    check(
      '拒绝访问写的是 role=none + deny=true(§5.3 的 UI 约定)',
      (before.body.rules ?? []).some((rule) => rule.deny === true && rule.role === 'none'),
    );

    const candidates = await api('GET', `/spaces/${dev.id}/permission-candidates`);
    check('候选主体接口返回成员', (candidates.body ?? []).some((item) => item.subjectType === 'user'));
    check('候选主体接口返回部门', (candidates.body ?? []).some((item) => item.subjectType === 'group'));

    // 重复主体 → 400(而不是让数据库抛唯一冲突变成 500)
    const members = await api('GET', `/spaces/${dev.id}/members`);
    const viewer = members.body.members.find((m) => m.email === 'viewer@example.com');
    const dup = await api('PUT', `/pages/${tech.id}/permissions`, {
      rules: [
        { subjectType: 'user', subjectId: viewer.userId, role: 'viewer', deny: false },
        { subjectType: 'user', subjectId: viewer.userId, role: 'editor', deny: false },
      ],
    });
    check('同一主体两条规则 → 400(而不是 500)', dup.status === 400, `实际 ${String(dup.status)}`);

    const emptySubject = await api('PUT', `/pages/${tech.id}/permissions`, {
      rules: [{ subjectType: 'user', subjectId: '   ', role: 'viewer', deny: false }],
    });
    check('空主体标识 → 400', emptySubject.status === 400, `实际 ${String(emptySubject.status)}`);

    const badRole = await api('PUT', `/pages/${tech.id}/permissions`, {
      rules: [{ subjectType: 'user', subjectId: viewer.userId, role: 'admin', deny: false }],
    });
    check('页面级不接受 admin 角色 → 400(管理员是空间层面的)', badRole.status === 400, `实际 ${String(badRole.status)}`);

    // 换成一条 group 规则,验证部门规则也能生效
    const after = await api('PUT', `/pages/${tech.id}/permissions`, {
      rules: [{ subjectType: 'group', subjectId: '设计部', role: 'viewer', deny: false }],
    });
    check('整表替换 → 200 且规则被替换', after.status === 200 && after.body.rules.length === 1);
    check('部门规则也能写入', after.body.rules[0]?.subjectType === 'group');

    // 恢复成种子里的 deny,方便用户按脚本提示验收
    await api('PUT', `/pages/${tech.id}/permissions`, {
      rules: [{ subjectType: 'user', subjectId: viewer.userId, role: 'none', deny: true }],
    });
  }

  // ================================================================
  // E. 评论(M5)
  // ================================================================
  console.log('\n【E. 页面评论】');
  {
    await loginAs('editor@example.com');
    const list = await api('GET', `/pages/${spec.id}/comments`);
    check('评论列表 → 200', list.status === 200);
    check(
      '种子评论在(2 条顶层 + 1 条回复)',
      list.body.total >= 3 && list.body.threads.some((t) => t.replies.length > 0),
      `total=${String(list.body.total)} 顶层=${String(list.body.threads.length)}`,
    );

    const created = await api('POST', `/pages/${spec.id}/comments`, { body: '验收脚本写入的评论' });
    check('发表评论 → 201', created.status === 201, `实际 ${String(created.status)}`);

    const replyToReply = await api('POST', `/pages/${spec.id}/comments`, {
      body: '试图回复一条回复',
      parentId: list.body.threads.find((t) => t.replies.length > 0).replies[0].id,
    });
    check('回复的回复 → 400(只允许一层)', replyToReply.status === 400, `实际 ${String(replyToReply.status)}`);

    const crossPage = await api('POST', `/pages/${tech.id}/comments`, {
      body: '跨页面引用别的评论',
      parentId: created.body.id,
    });
    check('跨页面的 parentId → 400', crossPage.status === 400, `实际 ${String(crossPage.status)}`);

    const emptyBody = await api('POST', `/pages/${spec.id}/comments`, { body: '   ' });
    check('空白评论 → 400', emptyBody.status === 400, `实际 ${String(emptyBody.status)}`);

    const resolved = await api('PATCH', `/comments/${created.body.id}`, { status: 'resolved' });
    check('作者标记自己的评论已解决 → 200', resolved.status === 200 && resolved.body.status === 'resolved');

    const counts = await api('GET', `/spaces/${dev.id}/comment-counts`);
    check('未解决评论数接口可用', counts.status === 200 && typeof counts.body === 'object');

    const removed = await api('DELETE', `/comments/${created.body.id}`);
    check('作者删除自己的评论 → 204', removed.status === 204, `实际 ${String(removed.status)}`);

    // 越权:只读成员不能发言,也不能标记别人的评论
    await loginAs('viewer@example.com');
    const viewerPost = await api('POST', `/pages/${spec.id}/comments`, { body: '只读成员发言' });
    check('只读成员发言 → 403', viewerPost.status === 403, `实际 ${String(viewerPost.status)}`);

    const otherComment = list.body.threads[0];
    const viewerResolve = await api('PATCH', `/comments/${otherComment.id}`, { status: 'resolved' });
    check('只读成员标记他人评论 → 403', viewerResolve.status === 403, `实际 ${String(viewerResolve.status)}`);

    const viewerDelete = await api('DELETE', `/comments/${otherComment.id}`);
    check('只读成员删除他人评论 → 403', viewerDelete.status === 403, `实际 ${String(viewerDelete.status)}`);
  }

  // ================================================================
  // F. 审计(M5)
  // ================================================================
  console.log('\n【F. 审计日志】');
  {
    await loginAs('admin@example.com');
    const logs = await api('GET', `/audit-logs?spaceId=${dev.id}&limit=50`);
    check('管理员查本空间审计 → 200', logs.status === 200);
    check('有审计记录', (logs.body.items ?? []).length > 0, `条数=${String(logs.body?.items?.length ?? 0)}`);
    const actions = new Set((logs.body.items ?? []).map((item) => item.action));
    check('记录了页面创建', actions.has('page.create'));
    check('记录了正文保存', actions.has('page.content.update'));
    check('记录了评论相关动作', actions.has('comment.create'));
    check('记录了权限变更', actions.has('perm.update'));
    check('记录了登录', actions.has('auth.login'));

    await loginAs('viewer@example.com');
    const viewerLogs = await api('GET', `/audit-logs?spaceId=${dev.id}`);
    check('只读成员查审计 → 403', viewerLogs.status === 403, `实际 ${String(viewerLogs.status)}`);

    const crossSpace = await api('GET', '/audit-logs');
    check('只读成员查跨空间审计 → 403', crossSpace.status === 403, `实际 ${String(crossSpace.status)}`);
  }

  // ================================================================
  // G. 导出(M6)
  // ================================================================
  console.log('\n【G. 导出 Markdown】');
  {
    await loginAs('editor@example.com');
    const res = await raw('GET', `${BASE}/pages/${spec.id}/export?format=md`);
    const text = await res.text();
    check('导出 → 200', res.status === 200);
    check('Content-Type 是 text/markdown', (res.headers.get('content-type') ?? '').includes('text/markdown'));
    check('Content-Disposition 带服务器端文件名', (res.headers.get('content-disposition') ?? '').includes('attachment'));
    check('正文以一级标题开头', text.startsWith('# 需求规格说明书'));
    check('表格导出成 GFM 表格', text.includes('| 角色 | 能力 |'));
    check('导出里没有三个以上连续空行', !/\n{3,}/.test(text));

    await loginAs('viewer@example.com');
    const denied = await raw('GET', `${BASE}/pages/${tech.id}/export?format=md`);
    check('导出被 deny 的页面 → 404', denied.status === 404, `实际 ${String(denied.status)}`);
  }

  // ================================================================
  // H. 附件上传与静态直出(M4 + Nginx)
  // ================================================================
  console.log('\n【H. 附件上传与直出】');
  {
    await loginAs('editor@example.com');

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'shot.png');
    const uploaded = await raw('POST', `${BASE}/uploads`, { body: form });
    const uv = await uploaded.json();
    check('上传 png → 201', uploaded.status === 201, `实际 ${String(uploaded.status)}`);
    check('返回的 url 前缀是 /uploads/', typeof uv?.url === 'string' && uv.url.startsWith('/uploads/'));

    // 通过 Nginx 静态直出(注意:不走 /api/v1)
    const served = await fetch(`${ROOT}${uv.url}`);
    check('Nginx 能直接出图(200)', served.status === 200, `实际 ${String(served.status)}`);
    check(
      '直出的 Content-Type 是 image/png',
      (served.headers.get('content-type') ?? '').includes('image/png'),
      served.headers.get('content-type') ?? '',
    );
    check('直出带 nosniff 头(防内容嗅探)', served.headers.get('x-content-type-options') === 'nosniff');

    // SVG 必须被拒(能内嵌脚本)
    const svgForm = new FormData();
    svgForm.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
    const svg = await raw('POST', `${BASE}/uploads`, { body: svgForm });
    check('上传 svg → 400(白名单不含 SVG)', svg.status === 400, `实际 ${String(svg.status)}`);

    const exeForm = new FormData();
    exeForm.append('file', new Blob(['MZ'], { type: 'application/octet-stream' }), 'a.png.exe');
    const exe = await raw('POST', `${BASE}/uploads`, { body: exeForm });
    check('上传 shell.png.exe → 400(双扩展名只看最后一段)', exe.status === 400, `实际 ${String(exe.status)}`);

    // 未登录不能上传
    cookie = '';
    const anon = await raw('POST', `${BASE}/uploads`, { body: new FormData() });
    check('未登录上传 → 401', anon.status === 401, `实际 ${String(anon.status)}`);
  }

  // ================================================================
  // I. 还原(让脚本可重复运行)
  // ================================================================
  console.log('\n【I. 还原被改动的数据】');
  {
    await loginAs('editor@example.com');
    if (original !== null) {
      const restored = await api('PUT', `/pages/${tech.id}/content`, {
        content: original,
        baseUpdatedAt: originalBase ?? undefined,
      });
      check('「技术方案」正文已还原', restored.status === 200, `实际 ${String(restored.status)}`);
    } else {
      check('「技术方案」正文已还原(无需还原)', true);
    }
  }

  // ================================================================
  // 汇总
  // ================================================================
  console.log(`\n${'='.repeat(70)}`);
  console.log(`通过 ${pass} 项,失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败明细:');
    for (const item of failures) console.log(`  ✗ ${item}`);
  }
  console.log('='.repeat(70));
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n✗ 验收脚本自身出错: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
