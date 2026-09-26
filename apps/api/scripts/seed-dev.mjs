/**
 * 开发/验收用的种子数据。
 *
 * 造出:
 *  - 两个空间 —— 验证「看不见的空间根本不出现在列表里」(§5.3 最小可见)
 *  - 五个账号,覆盖全部四种空间角色 + 一个跨空间隔离账号
 *  - 一棵**三层**页面树 —— M3 的验收口径正是「把一棵三层子树拖到另一个分支下」
 *  - **带正文的页面** —— 标题、列表、表格、代码块、图片,让检索(M4)一登录就有东西可搜
 *  - **评论与回复** —— 让评论面板不是空的
 *  - **一条 deny 规则 + 一条子级 allow** —— 用来亲眼看到「拒绝优先会短路,子级翻不了案」(§5.3)
 *  - 一个已删除的页面(带子页面),让回收站不是空的
 *
 * 用法(容器起来之后):
 *   pnpm seed:dev
 *   # 或指定接口与密码:
 *   KC_API=http://127.0.0.1:8080/api/v1 KC_SEED_PASSWORD=xxx node scripts/seed-dev.mjs
 *
 * ⚠️ 脚本只在**库为空**时可用(它要跑 /auth/setup)。要重来:
 *   docker compose down -v && docker compose up -d && pnpm seed:dev
 *
 * ⚠️ 这是开发数据,密码公开写死在这里。**不要把种子数据带到真实部署**。
 */
const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
const PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';

/** 1×1 的透明 PNG,用来验证「上传 → Nginx 直出」整条链路。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let cookie = '';

function syncCookie(res) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('\n')
      : (res.headers.get('set-cookie') ?? '');
  const matched = /kc_session=([^;]*)/.exec(raw);
  if (matched !== null) cookie = matched[1] === '' ? '' : `kc_session=${matched[1]}`;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie === '' ? {} : { Cookie: cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  syncCookie(res);
  const text = await res.text();
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${String(res.status)} ${text.slice(0, 300)}`);
  }
  return json;
}

/** 以某个账号登录(覆盖 cookie 变量)。 */
async function loginAs(email) {
  cookie = '';
  await api('POST', '/auth/login', { email, password: PASSWORD });
}

// ------------------------------------------------------------------
// 文档树构造小工具 —— 手写 JSON 太啰嗦
// ------------------------------------------------------------------

const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const p = (value) => ({ type: 'paragraph', content: value === '' ? [] : [text(value)] });
const h = (level, value) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const bullets = (...items) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [p(item)] })),
});
const codeBlock = (language, value) => ({
  type: 'codeBlock',
  attrs: { language },
  content: [text(value)],
});
const image = (src, alt) => ({ type: 'image', attrs: { src, alt } });
const table = (rows) => ({
  type: 'table',
  content: rows.map((cells, rowIndex) => ({
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
      content: [p(cell)],
    })),
  })),
});
const doc = (...content) => ({ type: 'doc', content });

async function createPage(spaceId, parentId, title) {
  const page = await api('POST', '/pages', { spaceId, parentId, title });
  return page.id;
}

async function setContent(pageId, content) {
  await api('PUT', `/pages/${pageId}/content`, { content });
}

async function main() {
  console.log(`接口: ${BASE}`);

  const state = await api('GET', '/auth/setup-state');
  if (state.required === false) {
    console.error('\n✗ 库里已经有数据了,种子脚本只能在空库上跑。');
    console.error('  要重来:docker compose down -v && docker compose up -d && pnpm seed:dev');
    process.exitCode = 1;
    return;
  }

  // ---------------- 初始化管理员 ----------------
  await api('POST', '/auth/setup', {
    email: 'admin@example.com',
    name: '管理员·林晓',
    password: PASSWORD,
  });
  console.log('✓ 初始化管理员 admin@example.com');

  // ---------------- 空间 1:研发中心 ----------------
  const dev = await api('POST', '/spaces', { name: '研发中心' });
  console.log(`✓ 空间「研发中心」 ${dev.id}`);

  // 带部门:阶段一的「用户组」就是部门,没有部门的账号无法演示组级权限规则
  const members = [
    ['editor@example.com', '编辑者·陈默', 'editor', '技术部'],
    ['commenter@example.com', '评论者·王思远', 'commenter', '技术部'],
    ['viewer@example.com', '只读·赵敏', 'viewer', '设计部'],
  ];
  for (const [email, name, role, department] of members) {
    await api('POST', `/spaces/${dev.id}/members`, {
      email,
      name,
      role,
      password: PASSWORD,
      department,
    });
  }
  console.log('✓ 加入 3 位不同角色的成员(技术部 ×2、设计部 ×1)');

  // ---------------- 三层页面树 ----------------
  // 产品文档 ─┬ 需求规格说明书 ─┬ 权限模型
  //           │                └ 分享链接
  //           └ 版本迭代记录
  // 技术方案 ── 接口设计约定
  // 新人手册 / 会议纪要
  const product = await createPage(dev.id, null, '产品文档');
  const spec = await createPage(dev.id, product, '需求规格说明书');
  const permModel = await createPage(dev.id, spec, '权限模型');
  const shareLink = await createPage(dev.id, spec, '分享链接');
  const release = await createPage(dev.id, product, '版本迭代记录');

  const tech = await createPage(dev.id, null, '技术方案');
  const apiConvention = await createPage(dev.id, tech, '接口设计约定');

  const handbook = await createPage(dev.id, null, '新人手册');
  const meeting = await createPage(dev.id, null, '会议纪要');

  // ---------------- 正文(让检索有东西可搜) ----------------
  await setContent(
    product,
    doc(
      h(1, '产品文档'),
      p('本空间存放研发中心的内部产品与技术资料。写作约定:能用表格就别写长段落,能举例就别讲道理。'),
      h(2, '资料分区'),
      bullets(
        '需求规格说明书 —— 需求的口径以这里为准,变更必须同步更新',
        '技术方案 —— 架构决策与取舍记录',
        '新人手册 —— 入职第一周需要知道的全部事情',
        '会议纪要 —— 决议与跟进项',
      ),
      h(2, '写作约定'),
      table([
        ['场景', '约定'],
        ['术语', '首次出现写全称,后续可用简称'],
        ['截图', '必须带说明文字,否则搜不到'],
        ['待确认', '用「待确认」开头,方便统一搜出来'],
      ]),
    ),
  );

  await setContent(
    spec,
    doc(
      h(1, '需求规格说明书'),
      p('本文描述知识库阶段一的完整需求。阶段一的目标不是功能多,而是让一个同事在内网里能完整用起来。'),
      h(2, '1. 范围'),
      p('阶段一交付:身份与权限、空间与页面树、正文编辑、中文检索、页面级评论、审计日志、备份与恢复。'),
      h(2, '2. 权限模型'),
      p('权限分四层继承:空间 → 页面链 → 显式规则 → 就近覆盖。拒绝优先,且拒绝会立即短路。'),
      table([
        ['角色', '能力'],
        ['空间管理员', '成员管理、页面彻底删除、权限设置、审计'],
        ['编辑者', '建页、改页、移动、软删除、恢复'],
        ['评论者', '查看、留言、标记自己的评论已解决'],
        ['只读成员', '仅查看'],
      ]),
      h(2, '3. 分享链接'),
      p('分享链接属于阶段二,阶段一只有站内访问。这里留一个标题是为了目录结构完整。'),
      h(2, '4. 非功能需求'),
      bullets(
        '中文检索必须可用 —— 这是选 pg_trgm 而不是 tsvector 的原因',
        '同一篇文档被两人同时编辑时,不能静默覆盖对方的修改',
        '页面移动之后,所有子孙的路径与深度必须一起重建',
      ),
    ),
  );

  await setContent(
    permModel,
    doc(
      h(1, '权限模型'),
      p('权限判定只存显式规则,不存最终结果 —— 运行时沿物化路径向上回溯计算。'),
      h(2, '四条铁律'),
      bullets(
        '拒绝优先:任一命中规则 deny=true 即短路,不受层级影响',
        '就近覆盖:更靠近自身的层覆盖更浅的层',
        '同层多规则:单个用户的规则强于部门的规则',
        '最小可见:无权访问一律返回未找到,不区分「不存在」与「无权」',
      ),
      h(2, '判定伪代码'),
      codeBlock(
        'text',
        'for (const layer of chainFromRootToSelf) {\n' +
          '  const matched = layer.rules.filter(hitsMe);\n' +
          '  if (matched.length === 0) continue;\n' +
          '  if (matched.some(deny)) return "none";   // 短路\n' +
          '  best = mostSpecific(matched).role;\n' +
          '}\n' +
          'return best ?? spaceRole;',
      ),
    ),
  );

  await setContent(
    shareLink,
    doc(
      h(1, '分享链接'),
      p('阶段二功能:生成一条带密码与有效期的对外链接。阶段一不做,此处仅保留占位。'),
    ),
  );

  await setContent(
    release,
    doc(
      h(1, '版本迭代记录'),
      p('倒序记录。每条写清:改了什么、为什么改、谁拍的板。'),
      bullets(
        'v0.4 —— 页面树与拖拽排序;移动时递归重建子树路径',
        'v0.3 —— 空间与成员管理;权限矩阵落成数据而不是散落的 if',
        'v0.2 —— 身份与会话;改用不透明会话 token 而不是 JWT',
        'v0.1 —— 基础设施:四个容器 + 健康检查 + 统一异常过滤器',
      ),
    ),
  );

  // 上传一张图片,插进「技术方案」—— 验证「上传 → Nginx 直出」整条链路
  let uploaded = null;
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(TINY_PNG_BASE64, 'base64')], { type: 'image/png' }),
      'architecture.png',
    );
    const res = await fetch(`${BASE}/uploads`, {
      method: 'POST',
      headers: cookie === '' ? {} : { Cookie: cookie },
      body: form,
    });
    if (res.ok) uploaded = await res.json();
  } catch {
    uploaded = null;
  }

  await setContent(
    tech,
    doc(
      h(1, '技术方案'),
      p('本页记录阶段一的架构决策。判断标准只有一条:出问题时能不能在半小时内定位。'),
      h(2, '部署形态'),
      p('四个容器:postgres、redis、api、web。web 同时承担静态资源与反向代理。'),
      h(2, '分层职责'),
      table([
        ['层', '做什么', '绝对不做'],
        ['Nginx', '静态资源、反向代理', '任何权限判断'],
        ['NestJS', '全部业务与鉴权', '拼 HTML'],
        ['PostgreSQL', '数据与检索', '业务规则'],
        ['Redis', '权限缓存、在线态', '作为唯一数据源'],
      ]),
      h(2, '为什么正文不能存 Markdown 字符串'),
      p('阶段二要挂协同编辑。Markdown 字符串无法与 CRDT 的文档模型一一对应,存了就得推倒重来。'),
      codeBlock(
        'sql',
        '-- 正文三列并存,阶段一只用前两列\n' +
          'content_json    jsonb  -- ProseMirror 文档树(唯一真相)\n' +
          'ydoc_snapshot   bytea  -- 阶段二的 CRDT 快照,现在保持 null\n' +
          'text_for_search text   -- 每次落库时同步拍的纯文本',
      ),
      ...(uploaded === null ? [] : [h(2, '架构图'), image(uploaded.url, '四层部署结构')]),
    ),
  );

  await setContent(
    apiConvention,
    doc(
      h(1, '接口设计约定'),
      p('所有接口挂在 /api/v1 下,统一返回 JSON。'),
      h(2, '错误码'),
      table([
        ['错误码', 'HTTP', '含义'],
        ['UNAUTHORIZED', '401', '未登录或会话过期'],
        ['FORBIDDEN', '403', '已登录但权限不足'],
        ['NOT_FOUND', '404', '不存在,或存在但无权访问'],
        ['VERSION_CONFLICT', '409', '乐观锁冲突,需重新拉取'],
      ]),
      p('注意 NOT_FOUND 刻意不区分「不存在」与「无权访问」,否则可以用错误码枚举出别人的文档 id。'),
    ),
  );

  await setContent(
    handbook,
    doc(
      h(1, '新人手册'),
      p('入职第一周需要知道的全部事情。'),
      h(2, '第一天'),
      bullets('领账号:找空间管理员邀请你加入对应空间', '读一遍本手册与产品文档', '在你的空间里建一篇「我的笔记」'),
      h(2, '常用操作'),
      table([
        ['想做的事', '怎么做'],
        ['找文档', 'Ctrl / Cmd + K,直接搜标题或正文'],
        ['建子页面', '鼠标移到页面树某一行,点 +'],
        ['调整顺序', '按住行拖到目标位置(上/中/下三个落点)'],
        ['讨论', '打开页面右侧的「评论」页签'],
      ]),
    ),
  );

  await setContent(
    meeting,
    doc(
      h(1, '会议纪要'),
      p('按时间倒序。每条纪要要写清决议与跟进人,没有跟进人的决议等于没开过会。'),
      h(2, '关于检索方案'),
      p('结论:阶段一用 pg_trgm + ILIKE,不用 PostgreSQL 自带的 tsvector。'),
      p('原因:tsvector 的分词器按空格与标点切词,中文没有空格,整句话会被当成一个词 —— 搜「权限」什么都搜不到。'),
    ),
  );

  console.log('✓ 写入 7 篇文档正文(含表格、代码块、图片)');

  // ---------------- 评论 ----------------
  await loginAs('commenter@example.com');
  const c1 = await api('POST', `/pages/${spec}/comments`, {
    body: '第二节的表格里,「评论者」是否包含外部顾问?建议单独列一条,否则口径会打架。',
  });
  await api('POST', `/pages/${spec}/comments`, {
    body: '同意。另外「分享链接」那一节的标题建议改成「对外分享(阶段二)」,免得新人以为现在就能用。',
  });
  await loginAs('editor@example.com');
  await api('POST', `/pages/${spec}/comments`, {
    body: '外部顾问按评论者处理,我在表格下面补一句说明。第二点接受,稍后改标题。',
    parentId: c1.id,
  });
  await api('POST', `/pages/${tech}/comments`, {
    body: '「Redis 不作为唯一数据源」这条写得好。建议在权限缓存那一节也点一下,免得后面有人图省事把会话挪进去。',
  });
  console.log('✓ 写入 4 条评论(含 1 条回复)');

  // ---------------- 页面级权限:一条 deny + 一条子级 allow ----------------
  // 目的:让人**亲眼看到** null 覆盖不了 deny —— 子页面的 allow 翻不了父页面的拒绝。
  const allMembers = await api('GET', `/spaces/${dev.id}/members`);
  const viewer = allMembers.members.find((m) => m.email === 'viewer@example.com');

  await loginAs('admin@example.com');
  if (viewer !== undefined) {
    await api('PUT', `/pages/${tech}/permissions`, {
      rules: [{ subjectType: 'user', subjectId: viewer.userId, role: 'none', deny: true }],
    });
    await api('PUT', `/pages/${apiConvention}/permissions`, {
      rules: [{ subjectType: 'user', subjectId: viewer.userId, role: 'viewer', deny: false }],
    });
    console.log('✓ 给「技术方案」加了 deny 规则,并给它的子页面写了一条 allow(用来看短路)');
  }

  // ---------------- 一个已删除的子树 ----------------
  await loginAs('admin@example.com');
  const draft = await createPage(dev.id, null, '临时草稿(已删除)');
  await createPage(dev.id, draft, '草稿下的子页面');
  await api('DELETE', `/pages/${draft}`);
  console.log('✓ 建好三层页面树,并删除一棵子树放进回收站');

  // ---------------- 空间 2:市场部空间(验证跨空间隔离) ----------------
  const marketing = await api('POST', '/spaces', { name: '市场部空间' });
  await api('POST', `/spaces/${marketing.id}/members`, {
    email: 'outsider@example.com',
    name: '市场部·孙浩',
    role: 'viewer',
    password: PASSWORD,
    department: '市场部',
  });
  console.log(`✓ 空间「市场部空间」 ${marketing.id}(只有 孙浩 一人)`);

  // ---------------- 汇总 ----------------
  const accounts = [
    ['admin@example.com', '管理员·林晓', '研发中心 = 空间管理员(所有者) / 市场部空间 = 空间管理员'],
    ['editor@example.com', '编辑者·陈默', '研发中心 = 编辑者'],
    ['commenter@example.com', '评论者·王思远', '研发中心 = 评论者'],
    ['viewer@example.com', '只读·赵敏', '研发中心 = 只读成员;看不到「技术方案」(被 deny)'],
    ['outsider@example.com', '市场部·孙浩', '只在市场部空间 —— 登录后**看不到**研发中心'],
  ];

  const emailWidth = Math.max(...accounts.map((a) => a[0].length));

  console.log(`\n${'='.repeat(78)}`);
  console.log('验收账号(密码全部相同)');
  console.log('='.repeat(78));
  for (const [email, name, note] of accounts) {
    console.log(`  ${email.padEnd(emailWidth)}  ${name}`);
    console.log(`  ${' '.repeat(emailWidth)}  ${note}`);
  }
  console.log('='.repeat(78));
  console.log(`  统一密码:  ${PASSWORD}`);
  console.log(`  入口:      http://localhost:8080/login`);
  console.log(`  研发中心:  http://localhost:8080/s/${dev.id}`);
  console.log('='.repeat(78));
  console.log('\n建议的验收顺序:');
  console.log('  1. 编辑者·陈默 登录 → 逐个页面点开:正文、表格、代码块、图片都在');
  console.log('     (图片能显示 = 上传 + Nginx 直出这条链路通了)');
  console.log('  2. 按 Ctrl / Cmd + K 搜「权限」→ 应命中「权限模型」与「需求规格说明书」');
  console.log('     再搜「CRDT」→ 命中「技术方案」的正文');
  console.log('  3. 编辑者·陈默 在「技术方案」里打字 → 右上角出现「正在保存…」→「已自动保存」');
  console.log('     刷新页面,内容还在');
  console.log('  4. 评论者·王思远 打开「需求规格说明书」→ 右侧「评论」页签:发表、回复、标记已解决');
  console.log('     页面树上该页会出现未解决评论的角标');
  console.log('  5. 只读·赵敏 登录 → 页面上没有编辑按钮、工具栏不出现、右侧也没有输入框;');
  console.log('     **重点**:左边的树上**看不到「技术方案」**——它被 deny 掉了,');
  console.log('     而它子页面的 allow 也翻不了这个案(拒绝优先会短路)');
  console.log('  6. 管理员·林晓 打开「技术方案」→ 点右上「权限」→ 能看到推导链与生效的规则');
  console.log('  7. 管理员·林晓 打开「技术方案」→ 点「导出 MD」→ 下载的 .md 用编辑器打开,层级正常');
  console.log('  8. 管理员·林晓 → 左侧 ⊞ 进空间 → 成员与角色 / 回收站 / 审计日志 三个入口都点一遍');
  console.log('  9. 市场部·孙浩 登录 → 左边只有「市场部空间」,研发中心完全不出现');
  console.log(' 10. 陈默 拖拽「需求规格说明书」(三层子树)到「技术方案」下 → 展开后子页面跟着走');
  console.log(' 11. 两人同时改同一页面标题 → 后提交的那个应收到冲突提示');
}

main().catch((error) => {
  console.error(`\n✗ 种子脚本失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
