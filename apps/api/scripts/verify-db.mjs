/**
 * 数据库契约自检 —— M1 验收用。
 *
 * 为什么用原生 pg 而不是 Prisma Client:
 * 这是个**验收脚本**,要能在 Prisma Client 生成失败、甚至依赖装了一半的情况下
 * 仍然告诉你数据库本身对不对。少一层依赖,少一个失败点。
 * (Prisma Client 自身能否工作,由 API 的 /health/ready 与后续接口验证。)
 *
 * 用法:pnpm --filter @knowledgecool/api run db:verify
 */
import 'dotenv/config';

import pg from 'pg';

const REQUIRED_EXTENSIONS = ['citext', 'pg_trgm'];
const REQUIRED_TABLES = [
  'users',
  'spaces',
  'space_members',
  'pages',
  'page_contents',
  'page_permissions',
  'comments',
  'audit_logs',
];
const REQUIRED_INDEXES = [
  'pages_tree_idx',
  'pages_path_idx',
  'pages_alive_idx',
  'page_contents_trgm_idx',
  'comments_page_idx',
  'audit_created_idx',
];
const REQUIRED_CHECKS = [
  'users_status_check',
  'space_members_role_check',
  'pages_status_check',
  'page_permissions_subject_type_check',
  'page_permissions_role_check',
  'comments_status_check',
];

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('✗ DATABASE_URL 未设置。请先配置 apps/api/.env');
  process.exit(1);
}

const failures = [];
const client = new pg.Client({ connectionString });

const column = async (sql) => (await client.query(sql)).rows.map((row) => String(Object.values(row)[0]));

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

  const pathDef = await indexDef('pages_path_idx');
  if (!pathDef.includes('text_pattern_ops')) {
    failures.push('pages_path_idx 未使用 text_pattern_ops,前缀查询会退化成全表扫描');
  }
  const aliveDef = await indexDef('pages_alive_idx');
  if (!/where/i.test(aliveDef)) {
    failures.push('pages_alive_idx 不是部分索引(缺少 WHERE deleted_at IS NULL)');
  }
  const trgmDef = await indexDef('page_contents_trgm_idx');
  if (!trgmDef.includes('gin_trgm_ops')) {
    failures.push('page_contents_trgm_idx 未使用 gin_trgm_ops');
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

  const count = (list, required) => `${list.filter((x) => required.includes(x)).length}/${required.length}`;

  console.log('');
  console.log('  扩展  :', extensions.filter((e) => REQUIRED_EXTENSIONS.includes(e)).join(', ') || '(无)');
  console.log('  表    :', count(tables, REQUIRED_TABLES));
  console.log('  索引  :', count(indexes, REQUIRED_INDEXES));
  console.log('  CHECK :', count(checks, REQUIRED_CHECKS));
  console.log('');
  console.log('  中文检索方案实测(『空间成员按职责划分』搜『空间』):');
  console.log('    tsvector 命中  :', probe.ts_hit, probe.ts_hit === false ? '← 印证 DESIGN.md §2.3:分词器确实不支持' : '');
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
