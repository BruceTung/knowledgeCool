/**
 * 数据库契约自检 —— 建库 / 迁移之后的验收用,v2.0 已按新模型更新。
 *
 * 为什么用原生 pg 而不是 Prisma Client:
 * 这是个**验收脚本**,要能在 Prisma Client 生成失败、甚至依赖装了一半的情况下
 * 仍然告诉你数据库本身对不对。少一层依赖,少一个失败点。
 * (Prisma Client 自身能否工作,由 API 的 `/health/ready` 与后续接口验证。)
 *
 * 用法:pnpm --filter @knowledgecool/api run db:verify
 */
import 'dotenv/config';

import pg from 'pg';

/** `citext` 不再需要 —— v2.2 起登录标识是工号(text),不是邮箱。 */
const REQUIRED_EXTENSIONS = ['pg_trgm'];

const REQUIRED_TABLES = [
  'users',
  'sessions',
  // 空间与页面合并后的统一资源(§4.1)
  'nodes',
  'node_contents',
  // v2.0 新增的两张关系表
  'org_assignments',
  'node_grants',
  /**
   * ⚠️ v2.12 的保密能力(v2.15 补进本清单)。
   *
   * 原来这里**没有** `node_readers` —— 于是"受限节点的读者名单表整张丢了"
   * 这件事在本自检里是看不见的,而它恰恰是保密功能的唯一载体。
   * 一张表没了却报告"契约通过",比自检跑不起来更危险。
   */
  'node_readers',
  'comments',
  'audit_logs',
];

/**
 * ⚠️ 这张清单里**没有** `spaces` / `space_members` / `page_permissions` /
 * `pages` / `page_contents` —— 它们在 v2.0 被废除。
 * 如果哪天有人把它们加回来,说明有人在往回改模型,应该先改 DESIGN。
 */
const FORBIDDEN_TABLES = ['spaces', 'space_members', 'page_permissions', 'pages', 'page_contents'];

/**
 * v2.12 起**必须不存在**的结构 —— 回收站被整体移除了。
 *
 * 留着列或索引意味着有人把软删除改回来了,而那种回退是**静默的**:
 * 代码里会重新出现 deleted_at 过滤,但没有任何地方会报错。
 */
const FORBIDDEN_INDEXES = ['nodes_alive_idx'];
const FORBIDDEN_NODE_COLUMNS = ['deleted_at', 'deleted_by'];

const REQUIRED_INDEXES = [
  'nodes_tree_idx',
  'nodes_path_idx',
  'nodes_owner_idx',
  'org_assignments_node_idx',
  'node_contents_trgm_idx',
  'comments_node_idx',
  'audit_created_idx',
];

const REQUIRED_CHECKS = [
  'users_status_check',
  'nodes_kind_check',
  'nodes_status_check',
  /**
   * ⚠️ v2.12 的 `visibility` 取值约束(v2.15 补进本清单)。
   *
   * 少了这条 CHECK,`nodes.visibility` 就能被写进任意字符串 ——
   * 而判定的写法是 `visibility === 'restricted'`(见 shared 的 `canRead`),
   * 于是一个**拼错的取值会让所有人都能读**(静默失守,不留痕迹)。
   * 数据库层是这个取值集合唯一说得上"被强制"的地方。
   */
  'nodes_visibility_check',
  // ⚠️ 这里**没有** `comments_status_check` —— 评论的 `status` 列(v2.4)已被删除。
  // 评论就是评论,不是"问题单":那套 open/resolved 的语义连同列一起去掉了。
  // 详见 DESIGN §5.4 与 `packages/shared/src/comment.ts` 的说明。
];

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('✗ DATABASE_URL 未设置。请先配置 apps/api/.env');
  process.exit(1);
}

const failures = [];
const client = new pg.Client({ connectionString });

const column = async (sql) =>
  (await client.query(sql)).rows.map((row) => String(Object.values(row)[0]));

async function main() {
  await client.connect();

  const extensions = await column('select extname from pg_extension');
  const tables = await column("select tablename from pg_tables where schemaname = 'public'");
  const indexes = await column("select indexname from pg_indexes where schemaname = 'public'");
  const checks = await column("select conname from pg_constraint where contype = 'c'");

  for (const name of REQUIRED_EXTENSIONS) {
    if (!extensions.includes(name)) failures.push(`缺少扩展 ${name}`);
  }
  for (const name of REQUIRED_TABLES) {
    if (!tables.includes(name)) failures.push(`缺少表 ${name}`);
  }
  for (const name of FORBIDDEN_TABLES) {
    if (tables.includes(name)) {
      failures.push(`表 ${name} 属于 v1.x 模型,应当在 v2.0 被删除 —— 有人改回去了?`);
    }
  }
  for (const name of REQUIRED_INDEXES) {
    if (!indexes.includes(name)) failures.push(`缺少索引 ${name}`);
  }
  for (const name of REQUIRED_CHECKS) {
    if (!checks.includes(name)) failures.push(`缺少 CHECK 约束 ${name}`);
  }

  // 手写进 migration 的三个索引必须**真的是**那个形态,名字对不代表语义对。
  const indexDef = async (name) =>
    (await client.query('select indexdef from pg_indexes where indexname = $1', [name])).rows[0]
      ?.indexdef ?? '';

  const pathDef = await indexDef('nodes_path_idx');
  if (!pathDef.includes('text_pattern_ops')) {
    failures.push('nodes_path_idx 未使用 text_pattern_ops,子孙前缀查询会退化成全表扫描');
  }
  for (const name of FORBIDDEN_INDEXES) {
    if (indexes.includes(name)) {
      failures.push(`索引 ${name} 属于已移除的回收站(v2.12),不应当存在`);
    }
  }
  const nodeColumns = await column(
    "select column_name from information_schema.columns where table_name = 'nodes'",
  );
  for (const name of FORBIDDEN_NODE_COLUMNS) {
    if (nodeColumns.includes(name)) {
      failures.push(`nodes.${name} 属于已移除的回收站(v2.12),不应当存在`);
    }
  }
  const trgmDef = await indexDef('node_contents_trgm_idx');
  if (!trgmDef.includes('gin_trgm_ops')) {
    failures.push('node_contents_trgm_idx 未使用 gin_trgm_ops');
  }
  // 树的同级排序索引必须带 position —— 少了它每次渲染组织树都要排序
  const treeDef = await indexDef('nodes_tree_idx');
  if (!treeDef.includes('position')) {
    failures.push('nodes_tree_idx 未包含 position,同级排序无法走索引');
  }

  /*
    ⚠️ v5.43 新增(P1-5):物化路径 ↔ parent_id 的一致性。
    =
    `materialized_path` 是**权限判定的性能基础**:`PermissionService.chainOf`
    靠它取祖先链,一旦它与 `parent_id` 不一致,取出来的链就是错的,
    而错链的表现是**静默的越权或失权** —— 不报错,只是有人能改了不该他改的东西。

    导入功能曾把物化路径写成"一级节点"(真实发生过),而这个不变式
    **此前没有任何地方检查**:schema 的 CHECK 约束管不了跨行不变式,
    类型检查看不见数据,现有门禁也都不查 —— 于是一致地通过了全部门禁。

    SQL 与 REMAINING.md §2 给的一致。它查两件事:
      1. depth 是否等于路径里的层级数
      2. 非根节点的路径是否等于「父节点路径 + / + 自己 id」
    每返回一行 = 一条断掉的祖先链 = 一处权限误判。
  */
  const brokenChains = (
    await client.query(
      `SELECT n.id, n.depth, n.materialized_path
         FROM nodes n
        WHERE n.depth <> length(n.materialized_path)
                       - length(replace(n.materialized_path, '/', '')) - 1
           OR (n.parent_id IS NOT NULL
               AND n.materialized_path <> (SELECT p.materialized_path || '/' || n.id
                                            FROM nodes p WHERE p.id = n.parent_id))
        LIMIT 20`,
    )
  ).rows;

  // 总节点数:给上面那行"自洽 ✓"一个对照,否则 0 处断裂看不出是"查过了"还是"库里没数据"
  const nodeCount = (await client.query('SELECT count(*)::int AS n FROM nodes')).rows[0]?.n ?? 0;

  if (brokenChains.length > 0) {
    failures.push(
      `物化路径与 parent_id 不一致:${brokenChains.length} 处(最多列 20)。` +
        '每一处都是一条断掉的祖先链,也就是一处权限误判。' +
        '修法:按 parent_id 自顶向下重算 materialized_path / depth。' +
        ' 首批: ' +
        brokenChains.map((r) => `${r.id}(depth=${r.depth}, path=${r.materialized_path})`).join(' '),
    );
  }

  // 组织归属是复合主键(user_id, node_id):重复归属必须由数据库挡住,
  // 因为导入是"幂等追加"的语义,靠应用层去重一旦漏了就会长出重复行。
  const assignmentPk = (
    await client.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'org_assignments'::regclass and contype = 'p'`,
    )
  ).rows[0]?.def;
  if (assignmentPk === undefined || !assignmentPk.includes('user_id')) {
    failures.push('org_assignments 缺少 (user_id, node_id) 复合主键');
  }

  // 中文检索方案实测 —— 验证 DESIGN.md §2.3 的判断。
  // 期望:tsvector 命中 false(分词器不支持无空格中文),ILIKE 命中 true。
  const probe = (
    await client.query(
      `select
         to_tsvector('simple', '空间成员按职责划分') @@ to_tsquery('simple', '空间') as ts_hit,
         ('空间成员按职责划分' ilike '%空间%') as ilike_hit,
         similarity('空间成员按职责划分', '空间') as sim`,
    )
  ).rows[0];

  if (probe.ilike_hit !== true) {
    failures.push('ILIKE 中文子串匹配失败 —— pg_trgm 检索方案不成立');
  }

  const count = (list, required) =>
    `${list.filter((x) => required.includes(x)).length}/${required.length}`;

  console.log('');
  console.log(
    '  扩展  :',
    extensions.filter((e) => REQUIRED_EXTENSIONS.includes(e)).join(', ') || '(无)',
  );
  console.log('  表    :', count(tables, REQUIRED_TABLES));
  console.log('  索引  :', count(indexes, REQUIRED_INDEXES));
  console.log('  CHECK :', count(checks, REQUIRED_CHECKS));
  const leftovers = tables.filter((t) => FORBIDDEN_TABLES.includes(t));
  console.log('  v1 残留:', leftovers.length === 0 ? '无 ✓' : leftovers.join(', '));
  console.log(
    '  祖先链一致性:',
    brokenChains.length === 0
      ? `全部 ${String(nodeCount)} 个节点的 depth 与 materialized_path 自洽 ✓`
      : `${String(brokenChains.length)} 处断裂 ✗`,
  );
  console.log('');
  console.log('  中文检索方案实测(『空间成员按职责划分』搜『空间』):');
  console.log(
    '    tsvector 命中  :',
    probe.ts_hit,
    probe.ts_hit === false ? '← 印证 DESIGN.md §2.3:分词器确实不支持' : '',
  );
  console.log('    ILIKE 子串命中 :', probe.ilike_hit);
  console.log('    三元组相似度   :', probe.sim);
  console.log('');

  if (failures.length > 0) {
    console.error('✗ 数据库契约自检未通过:');
    for (const failure of failures) console.error(`   - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ 数据库契约自检通过');
}

main()
  .catch((error) => {
    console.error('✗ 自检脚本异常退出:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
