/**
 * 把演示账号还原成 DEMO-ACCOUNTS.txt 描述的状态。
 *
 * ## 为什么需要它
 *
 * `verify-org.mjs` 里有一段「验证首次登录强制改密」的断言:它用**初始密码**
 * 登录 KC003,然后**真的把密码改掉**(要验就真验,不能只看界面)。
 *
 * 副作用是:**跑过一次验收之后,演示账号的密码就不再是文档里写的那个了。**
 * 于是出现一件很坑的事 —— 你拿着 `DEMO-ACCOUNTS.txt` 去登录,提示密码错误,
 * 而文档并没有写错,是脚本改过。
 *
 * 这个脚本把指定账号还原成「初始密码 `123456` + 首登强制改密」。
 *
 * ## 用法(必须在 api 容器里跑 —— 只有那里有 DATABASE_URL 与依赖)
 *
 *   # 默认还原 KC003 / KC004
 *   docker compose exec api node scripts/reset-demo-passwords.mjs
 *
 *   # 指定工号
 *   docker compose exec api node scripts/reset-demo-passwords.mjs KC003 KC005
 *
 * ## ⚠️ 三条必须知道的事
 *
 * 1. **它直接写库,不走 API、不留审计。** 这是有意的:系统里**没有**
 *    "重置密码"这个接口,而且不该有 —— 超管能重置任何人的密码,等于超管能冒充任何人。
 *    演示环境用直连库是最省事的做法;**正式环境不要把这个脚本拿来乱跑**。
 * 2. **它会踢掉这些人的所有会话。** 会话表里存的是 token 的 SHA-256,
 *    改密码不会让已发出的会话失效 —— 不删的话会出现"改完密码,旧标签页还能用",
 *    演示时看起来像没生效。
 * 3. **它是幂等的**,反复跑没问题。
 */

import { hash } from '@node-rs/bcrypt';
import pg from 'pg';

/** 与 shared 的 `INITIAL_PASSWORD` 保持一致(内置常量,不进 Excel 模板)。 */
const INITIAL_PASSWORD = '123456';

/** 与 `PasswordService.SALT_ROUNDS` 保持一致 —— 两个数字漂移了不会报错,只会让人困惑。 */
const SALT_ROUNDS = 12;

/** 默认还原这两个:`DEMO-ACCOUNTS.txt` 里说它们是 `123456`,而验收脚本会改掉它们。 */
const DEFAULT_TARGETS = ['KC003', 'KC004'];

const targets = process.argv.slice(2);
const employeeNos = targets.length > 0 ? targets : DEFAULT_TARGETS;

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  console.error('✗ 没有 DATABASE_URL —— 这个脚本要在 api 容器里跑(compose 会注入它):');
  console.error('    docker compose exec api node scripts/reset-demo-passwords.mjs');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const passwordHash = await hash(INITIAL_PASSWORD, SALT_ROUNDS);

  for (const employeeNo of employeeNos) {
    const found = await client.query('SELECT id, name FROM users WHERE employee_no = $1', [
      employeeNo,
    ]);

    if (found.rowCount === 0) {
      console.log(`· ${employeeNo} 不存在,跳过`);
      continue;
    }

    const { id, name } = found.rows[0];

    await client.query(
      'UPDATE users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2',
      [passwordHash, id],
    );

    const killed = await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);

    console.log(
      `✓ ${employeeNo} ${name} → 密码还原为 ${INITIAL_PASSWORD},下次登录强制改密` +
        `(已踢掉 ${String(killed.rowCount)} 个会话)`,
    );
  }

  console.log('\n提示:正式环境不要留着这个脚本乱跑 —— 它直接写库、不走 API、不留审计。');
} finally {
  await client.end();
}
