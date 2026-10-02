/**
 * 附件孤儿文件的**盘点**与(可选)回收。
 *
 * ## 什么是孤儿
 *
 * 上传接口把文件写进 UPLOAD_DIR,返回 /uploads/<uuid>.<ext>;前端拿到 URL 之后
 * 才把它插进正文。所以**「文件存在」与「被引用」是两件事**:
 *
 *   PageEditor.handleImage:
 *     const result = await upload.mutateAsync(file);   // ← 此刻文件已经落盘
 *     editor.chain().focus().setImage({ src: result.url }).run();  // ← 此刻才有引用
 *
 * 中间任何一步没走完(用户取消、插入失败、**插了但没保存就离开**),
 * 文件就留在磁盘上而正文里没有它 —— 这就是孤儿。
 *
 * 注意最后那条不是边缘情况:**插了图但没保存**是最常见的正常操作路径。
 *
 * ## 为什么默认只盘点、不删
 *
 * 删除是**不可逆**的,而「没有引用」这个判据**可能误伤**正在编辑的人:
 * 用户上传了图、还没保存,此刻它在库里的确「无引用」。
 * 所以规则有三条:
 *
 *   1. **默认 dry-run**,只打印;要真删必须显式 --delete;
 *   2. **只碰超过 --min-age-hours(默认 24 小时)的文件** ——
 *      给「正在编辑但还没保存」留出足够宽的窗口;
 *   3. 引用判定用 content_json::text LIKE '%<filename>%'。
 *      文件名是服务端生成的 UUID + 后缀,**全局唯一**,不会误匹配别的文件。
 *
 * ## 用法
 *
 * ⚠️ **运行时镜像里没有 pnpm**(只有 node 与 npm),所以生产上要在**容器内**用 node 跑:
 *
 *   docker compose exec -w /app/apps/api api node scripts/prune-uploads.mjs
 *   docker compose exec -w /app/apps/api api node scripts/prune-uploads.mjs --delete
 *
 * 开发机上(装了 pnpm、且 DATABASE_URL 指得到库)才用:
 *
 *   pnpm --filter @knowledgecool/api run uploads:orphans
 *
 * 与 verify-db.mjs 一样用原生 pg:这是个运维脚本,
 * 要能在 Prisma Client 出问题时照样跑。
 */
import 'dotenv/config';

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './data/uploads';

/** 只回收「最后一次修改早于这个小时数」的文件,给未保存的编辑留窗口。 */
function parseMinAgeHours(argv) {
  const i = argv.indexOf('--min-age-hours');
  if (i < 0) return 24;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error('--min-age-hours 需要一个非负数,收到:' + String(raw));
    process.exit(1);
  }
  return n;
}

const argv = process.argv.slice(2);
const DELETE = argv.includes('--delete');
const MIN_AGE_HOURS = parseMinAgeHours(argv);

const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://knowledgecool:knowledgecool@localhost:5432/knowledgecool',
});

/** 某个文件名是否出现在任意一份正文里。 */
async function isReferenced(name) {
  const res = await client.query(
    'SELECT 1 FROM node_contents WHERE content_json::text LIKE $1 LIMIT 1',
    ['%' + name + '%'],
  );
  return res.rowCount > 0;
}

async function main() {
  await client.connect();

  let names;
  try {
    names = await readdir(UPLOAD_DIR);
  } catch (error) {
    console.error('读不到上传目录 ' + UPLOAD_DIR + ':' + String(error.message));
    await client.end();
    process.exit(1);
  }

  console.log('上传目录:' + UPLOAD_DIR);
  console.log('文件数  :' + String(names.length));
  console.log('模式    :' + (DELETE ? '**删除**' : '只盘点(加 --delete 才真删)'));
  console.log('年龄下限:' + String(MIN_AGE_HOURS) + ' 小时');
  console.log('');

  const cutoff = Date.now() - MIN_AGE_HOURS * 3600 * 1000;
  let referenced = 0;
  let tooNew = 0;
  let orphans = 0;
  let bytes = 0;
  let removed = 0;

  for (const name of names) {
    const full = join(UPLOAD_DIR, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue; // 竞态:盘点期间被别的进程删了
    }
    if (!info.isFile()) continue;

    if (await isReferenced(name)) {
      referenced += 1;
      continue;
    }
    if (info.mtimeMs > cutoff) {
      tooNew += 1;
      continue;
    }

    orphans += 1;
    bytes += info.size;
    console.log('  孤儿  ' + name + '  ' + String(info.size) + ' 字节');
    if (DELETE) {
      await unlink(full);
      removed += 1;
    }
  }

  console.log('');
  console.log('已引用    :' + String(referenced));
  console.log('太新跳过  :' + String(tooNew));
  console.log('孤儿      :' + String(orphans) + '(' + String(Math.round(bytes / 1024)) + ' KB)');
  if (DELETE) console.log('已删除    :' + String(removed));
  else if (orphans > 0) console.log('(只盘点,未删除。确认无误后加 --delete)');

  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
