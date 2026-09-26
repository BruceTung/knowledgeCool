/**
 * 开发/验收用的种子数据(DESIGN.md 未要求,是为了「多人一起验收」而写的)。
 *
 * 造出:
 *  - 两个空间 —— 用来验证「看不见的空间根本不出现在列表里」(§5.3 最小可见)
 *  - 五个账号,覆盖全部四种空间角色 + 一个跨空间隔离账号
 *  - 一棵**三层**页面树 —— M3 的验收口径正是「把一棵三层子树拖到另一个分支下」
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
 * ⚠️ 这是开发数据,密码是公开写死在这里的。**不要把种子数据带到真实部署**。
 */
const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
const PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';

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
  // 三条路径(try 里解析成功、解析失败、空体)都会给它赋值,所以不写初始值
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

/** 建一个页面并返回它的 id。 */
async function createPage(spaceId, parentId, title) {
  const page = await api('POST', '/pages', { spaceId, parentId, title });
  return page.id;
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

  const members = [
    ['editor@example.com', '编辑者·陈默', 'editor'],
    ['commenter@example.com', '评论者·王思远', 'commenter'],
    ['viewer@example.com', '只读·赵敏', 'viewer'],
  ];
  for (const [email, name, role] of members) {
    await api('POST', `/spaces/${dev.id}/members`, { email, name, role, password: PASSWORD });
  }
  console.log(`✓ 加入 3 位不同角色的成员`);

  // ---------------- 三层页面树 ----------------
  // 产品文档 ─┬ 需求规格说明书 ─┬ 权限模型
  //           │                └ 分享链接
  //           └ 版本迭代记录
  // 技术方案 ── 接口设计约定
  // 新人手册 / 会议纪要
  const product = await createPage(dev.id, null, '产品文档');
  const spec = await createPage(dev.id, product, '需求规格说明书');
  await createPage(dev.id, spec, '权限模型');
  await createPage(dev.id, spec, '分享链接');
  await createPage(dev.id, product, '版本迭代记录');

  const tech = await createPage(dev.id, null, '技术方案');
  await createPage(dev.id, tech, '接口设计约定');

  await createPage(dev.id, null, '新人手册');
  await createPage(dev.id, null, '会议纪要');

  // 一个已删除的子树,让回收站不是空的
  const draft = await createPage(dev.id, null, '临时草稿(已删除)');
  await createPage(dev.id, draft, '草稿下的子页面');
  await api('DELETE', `/pages/${draft}`);
  console.log('✓ 建好三层页面树,并删除一棵子树放进回收站');

  // ---------------- 空间 2:市场部空间(用于验证跨空间隔离) ----------------
  const marketing = await api('POST', '/spaces', { name: '市场部空间' });
  await api('POST', `/spaces/${marketing.id}/members`, {
    email: 'outsider@example.com',
    name: '市场部·孙浩',
    role: 'viewer',
    password: PASSWORD,
  });
  console.log(`✓ 空间「市场部空间」 ${marketing.id}(只有 孙浩 一人)`);

  // ---------------- 汇总 ----------------
  const accounts = [
    ['admin@example.com', '管理员·林晓', '研发中心 = 空间管理员(所有者) / 市场部空间 = 空间管理员'],
    ['editor@example.com', '编辑者·陈默', '研发中心 = 编辑者'],
    ['commenter@example.com', '评论者·王思远', '研发中心 = 评论者'],
    ['viewer@example.com', '只读·赵敏', '研发中心 = 只读成员'],
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
  console.log('\n建议的验收动作(按顺序):');
  console.log('  1. 各自登录,确认「市场部·孙浩」看不到研发中心(最小可见)');
  console.log('  2. 只读·赵敏 / 评论者·王思远:树上没有新建/重命名/删除按钮,也拖不动');
  console.log('  3. 编辑者·陈默:拖拽「需求规格说明书」(三层子树)到「技术方案」下');
  console.log('     —— 展开后子页面应跟着走,这就是 M3 的核心验收点');
  console.log('  4. 两人同时改同一页面标题 → 后提交的那个应收到 409 冲突提示');
  console.log('  5. 删除一个带子页面的节点 → 恢复后整棵子树回来');
  console.log('  6. 管理员进回收站 → 「彻底删除」,其他人看不到这个按钮');
}

main().catch((error) => {
  console.error(`\n✗ 种子脚本失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
