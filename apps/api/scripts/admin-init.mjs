#!/usr/bin/env node
/**
 * 初始化 / 重置账号 —— **管理员在生产环境自己执行的入口**。
 *
 * ============================ 它解决什么问题 ============================
 *
 * 系统需要一份"能登进去"的数据。旧的办法是 `seed-dev.mjs`,但它:
 *   · **要求先清库**(`docker compose down -v`)—— 在生产上执行等于删库;
 *   · 把密码**明文写在脚本与 DEMO-ACCOUNTS.txt 里**;
 *   · 走 Excel 导入,依赖一个 xlsx 文件。
 *
 * 这个脚本是那三件事的替代品:
 *   · **不清库**,只做幂等的 upsert;
 *   · 密码**一个都不在仓库里**,由执行的人在运行时提供;
 *   · 不依赖任何外部文件。
 *
 * ================================ 用法 ==================================
 *
 * ```bash
 * # 1) 首次部署:交互式输入初始密码(推荐,密码不进任何文件)
 *    docker compose exec api node scripts/admin-init.mjs
 *
 * # 2) 自动化(CI / 首次部署脚本):从环境变量读
 *    #    ⚠️ 这个值会进容器的环境变量,所以**首次部署后要立刻 unset**
 *    KC_INIT_PASSWORD='...' docker compose exec -e KC_INIT_PASSWORD \
 *      api node scripts/admin-init.mjs
 *
 * # 3) 只看会做什么,不写任何东西
 *    docker compose exec api node scripts/admin-init.mjs --dry-run
 *
 * # 4) ⚠️ 覆盖已存在账号的密码(**破坏性,需二次确认**)
 *    docker compose exec api node scripts/admin-init.mjs --overwrite-users
 *
 * # 5) 只重置某一个人的密码(忘了密码时的正解)
 *    docker compose exec api node scripts/admin-init.mjs --reset-password KC002
 *
 * # 6) 从文件读账号(批量导入要用的形态;**文件不进仓库**)
 *    docker compose exec api node scripts/admin-init.mjs --from-file /tmp/roster.xlsx
 * ```
 *
 * =========================== 为什么密码不落盘 ===========================
 *
 * ① 脚本**不回显**密码,只回显"用的是哪个来源";
 * ② 交互式输入走 TTY 静默读取(stdin 不回显),不是 `readFileSync`;
 * ③ bcrypt 的 cost 参数与生产一致(10),**不为了"种得快"降下来** ——
 *    种子哈希被爆破的成本必须与真实账号一致,否则那批数据是个筛子;
 * ④ 交互式输入**不要求 8 位数字+字母**那套强度规则 ——
 *    管理员给同事设的初始口令可能是 `123456`,而这正是 §6.1.2 要他改掉的。
 *    强度是**用户自己改密时**的事,不是管理员设初始值时的事。
 *
 * ============================== 安全边界 =================================
 *
 * · 已存在的账号默认**只报告不动**(`--overwrite-users` 才改);
 * · 所有写操作进 `audit_logs`(动作 `user.seed.*`);
 * · 脚本**不需要**先有一个超管会话 —— 它直连数据库。
 *   这是刻意的:它必须能在"谁都登不进去"的场景下用。
 *   因此它的正确性靠**代码审阅**与**审计留痕**,不靠登录态。
 * · 密码只存在于进程内存,GC 后即不可恢复 —— 忘了就再跑一次。
 */

import { hash } from '@node-rs/bcrypt';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import pg from 'pg';

import {
  DEFAULT_ON_EXISTING,
  SEED_ACCOUNTS,
  SEED_DEPARTMENTS,
  SEED_DOCUMENTS,
  SEED_SUB_NODES,
} from './seed/accounts.mjs';

const { Client } = pg;

/**
 * bcrypt cost —— **必须与 `PasswordService.SALT_ROUNDS` 一致(12)**。
 *
 * ⚠️ 这里第一版写的是 10,而应用是 12 —— 一个**不会报任何错**的偏差:
 * bcrypt 校验只看 cost 是否写在哈希串里(`$2b$12$…`),所以 10 生成的哈希
 * 照样能登录。于是代价不在功能,在**安全**:一批 cost 10 的账号比其它账号
 * 弱 4 倍(12 相对 10),而没有任何地方会提示这一点。
 *
 * 另一个后果是"下次改密就升级了" —— 用户自己一改密就变 12,
 * 于是**只有从没改过密的人**停在弱档上,而那恰恰是最该被保护的初始状态。
 *
 * → 改动这个数字时,`password.service.ts` 与 `reset-demo-passwords.mjs`
 * 要一起改。三处漂移不会报错,只会让人困惑。
 */
const SALT_ROUNDS = 12;

/** 走 API 的初始密码(§6.1.2)。管理员设的初始值不受它约束,见文件头 ④。 */
const INITIAL_PASSWORD = '123456';

// ============================================================
// 参数
// ============================================================

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const DRY_RUN = has('--dry-run');
const OVERWRITE_USERS = has('--overwrite-users');
const RESET_PASSWORD_FOR = valueOf('--reset-password');
const FROM_FILE = valueOf('--from-file');
const YES = has('--yes');

/** 显式声明这次是什么操作 —— 它决定要不要问那句"你确定"。 */
let MODE = SEED_ACCOUNTS.length > 0 ? 'seed' : 'noop';
if (RESET_PASSWORD_FOR !== undefined) MODE = 'reset-password';
else if (FROM_FILE !== undefined) MODE = 'import';
else if (OVERWRITE_USERS) MODE = 'overwrite';

// ============================================================
// 输出 helpers —— ⚠️ 每一个都**不许**打印密码
// ============================================================

const log = (line = '') => stdout.write(`${line}\n`);
const ok = (line) => log(`  ✓ ${line}`);
const warn = (line) => log(`  ⚠ ${line}`);
const bad = (line) => log(`  ✗ ${line}`);
const die = (line, code = 1) => {
  bad(line);
  process.exit(code);
};

/** 环境变量里有没有可用口令。**空字符串算没有** —— 它多半是 `-e KC_INIT_PASSWORD=` 漏了值。 */
function hasEnvPassword() {
  const value = process.env['KC_INIT_PASSWORD'];
  return value !== undefined && value !== '';
}

/** 只说"密码来自哪里",绝不说是什么。 */
function describePasswordSource(kind) {
  if (kind === 'env') return '环境变量 KC_INIT_PASSWORD(本次进程内有效,不落盘)';
  if (kind === 'prompt') return '交互式输入(静默读取,不回显、不落盘)';
  if (kind === 'preset') return `内置初始密码(§6.1.2 的${INITIAL_PASSWORD})`;
  return '未提供';
}

// ============================================================
// 密码获取 —— 三个来源,优先级:交互 > 环境变量 > 内置
// ============================================================

/**
 * 静默读一行(不回显)。
 *
 * ⚠️ `readline` 在非 TTY 下**无法**做到不回显,此时直接失败:
 * 宁可让脚本在这里停下,也不要在一个会**把密码打进日志**的终端上继续 ——
 * CI 的日志是公开的。
 */
function promptSecret(question) {
  if (!stdin.isTTY) {
    die(
      '当前不是交互式终端,无法安全地读取密码(会回显)。\n' +
        '  两种办法:\n' +
        '    · 交互执行:docker compose exec -T api node scripts/admin-init.mjs(去掉 -T)\n' +
        '    · 用环境变量:KC_INIT_PASSWORD=... docker compose exec -e KC_INIT_PASSWORD ...',
    );
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    // 关掉回显:readline 的 terminal 模式会打印输入,这里用临时改写 stdout 屏蔽
    const originalWrite = stdout.write.bind(stdout);
    stdout.write = () => true;
    stdout.write(`${question}`);
    rl.question('', (answer) => {
      stdout.write = originalWrite;
      stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function resolvePassword(kind) {
  if (kind === 'env') {
    const fromEnv = process.env['KC_INIT_PASSWORD'];
    if (fromEnv === undefined || fromEnv === '') {
      die('KC_INIT_PASSWORD 已传但为空。');
    }
    return fromEnv;
  }
  if (kind === 'prompt') {
    const answer = await promptSecret('请输入这个账号的密码(输入不回显):');
    if (answer.trim() === '') die('密码不能为空。');
    return answer;
  }
  return INITIAL_PASSWORD;
}

// ============================================================
// 数据库
// ============================================================

function connect() {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    die(
      '没有 DATABASE_URL —— 这个脚本要在 api 容器里跑(compose 会注入它)。\n' +
        '  例:docker compose exec api node scripts/admin-init.mjs',
    );
  }
  const client = new Client({ connectionString });
  return client.connect().then(
    () => client,
    (error) => {
      die(`连不上数据库:${error instanceof Error ? error.message : String(error)}`);
      return client;
    },
  );
}

// ============================================================
// 危险操作确认 —— 只在真的会写、且是不可逆的那一步问
// ============================================================

/**
 * 破坏性操作的确认 —— **只在真的会写不可逆的东西时问一次**。
 *
 * ⚠️ 为什么要"只在不可逆时问":如果每次都问,人会形成反射性地敲 y,
 * 于是那个问题就白问了 —— 它从"一道闸"退化成"一个仪式"。
 * 而这个脚本里真正不可逆的只有一件事:**覆盖已存在账号的密码**。
 * 建新账号是可逆的(把状态改成已停用即可),所以那边不拦。
 *
 * 三种通过方式:
 *   · 交互式:看清提示后敲 `yes`(不是 y —— 少误触一次是一次);
 *   · 非 TTY:必须显式 `--yes`,否则**拒绝执行**。CI 里没有 TTY,
 *     而"自动化"不等于"可以跳过确认";
 *   · `--dry-run`:不写任何东西,自然不需要确认。
 */
async function confirmDestructive() {
  if (DRY_RUN) return true;
  if (YES) {
    warn('已用 --yes 跳过确认。');
    return true;
  }
  if (!stdin.isTTY) {
    die(
      '这是破坏性操作(会重置已存在账号的密码),而当前不是交互式终端,无法确认。\n' +
        '  确认它确实是你要做的之后,加 --yes 重跑。\n' +
        '  如果你只是想看看会改什么,加 --dry-run —— 它一个字节都不写。',
    );
  }
  const answer = await promptSecret('真的要覆盖已存在账号的密码吗?输入 yes 继续:');
  const confirmed = answer.trim() === 'yes';
  if (!confirmed) {
    log('');
    log('已取消(没有做任何改动)。');
  }
  return confirmed;
}

// ============================================================
// 账号 upsert
// ============================================================

/**
 * 建 / 更新一个账号。
 *
 * ⚠️ `onExisting` 是这个函数的核心 —— 它决定**已经存在的账号会不会被改动**。
 * 默认 `skip`:什么都不做,只报告"他在,状态是 X"。
 */
async function upsertAccount(client, account, password, onExisting) {
  const found = await client.query(`SELECT id, name, status FROM users WHERE employee_no = $1`, [
    account.employeeNo,
  ]);

  /*
   * ⚠️ bcrypt 只在**真的要写**的时候才算。
   * cost 10 大约 60ms,而 `skip`(默认路径)一个字节都不写 ——
   * 在它前面算 hash 等于每次跑都白付 5 次 bcrypt。
   *
   * 而且这不只是慢:它让"只读模式"也付出了写模式的代价,
   * 于是将来有人为了省这两秒把 cost 调低,种子哈希就成了筛子。
   */
  const hashNow = async () => hash(password, SALT_ROUNDS);

  if (found.rowCount === 0) {
    if (DRY_RUN) {
      warn(`${account.employeeNo} ${account.name} —— 将新建(现在不动)`);
      return { created: true };
    }
    const created = await client.query(
      `INSERT INTO users (employee_no, name, password_hash, must_change_password,
                          avatar_color, status, is_super_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        account.employeeNo,
        account.name,
        await hashNow(),
        account.passwordMode === 'initial',
        account.avatarColor ?? 'gray',
        account.status ?? 'active',
        account.isSuperAdmin === true,
      ],
    );
    ok(`${account.employeeNo} ${account.name} —— 已新建`);
    return { created: true, id: created.rows[0].id };
  }

  const existing = found.rows[0];
  const desiredMode = account.passwordMode === 'initial';

  if (onExisting === 'skip') {
    ok(`${account.employeeNo} ${account.name} —— 已存在(status=${existing.status}),**未改动**`);
    return { created: false, id: existing.id };
  }

  if (onExisting === 'updateOrgOnly') {
    if (DRY_RUN) {
      warn(`${account.employeeNo} —— 将同步姓名/角色/归属,密码与状态不动`);
      return { created: false, id: existing.id };
    }
    await client.query(
      `UPDATE users SET name = $2, is_super_admin = $3, avatar_color = COALESCE($4, avatar_color),
                         updated_at = now()
         WHERE id = $1`,
      [existing.id, account.name, account.isSuperAdmin === true, account.avatarColor ?? null],
    );
    ok(`${account.employeeNo} —— 已同步姓名与角色(密码未动)`);
    return { created: false, id: existing.id };
  }

  // onExisting === 'overwrite' —— 唯一会动既有密码的分支
  if (DRY_RUN) {
    warn(`${account.employeeNo} ${account.name} —— ⚠ 将覆盖密码(现在不动)`);
    return { created: false, id: existing.id };
  }
  await client.query(
    `UPDATE users
        SET name = $2, password_hash = $3, must_change_password = $4,
            is_super_admin = $5, avatar_color = COALESCE($6, avatar_color),
            status = COALESCE($7, status), updated_at = now()
      WHERE id = $1`,
    [
      existing.id,
      account.name,
      await hashNow(),
      desiredMode,
      account.isSuperAdmin === true,
      account.avatarColor ?? null,
      account.status ?? null,
    ],
  );
  ok(`${account.employeeNo} ${account.name} —— ⚠ 已覆盖密码`);
  return { created: false, id: existing.id };
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  log('知源 KnowledgeCool · 初始化 / 重置账号');
  log('='.repeat(56));

  if (DRY_RUN) {
    log('');
    log('【--dry-run】下面只报告将要做什么,一个字节都不会写。');
  }

  // ---- 模式 1:重置单个账号的密码 ----
  if (MODE === 'reset-password') {
    const employeeNo = RESET_PASSWORD_FOR;
    const client = await connect();
    try {
      const found = await client.query(`SELECT id, name FROM users WHERE employee_no = $1`, [
        employeeNo,
      ]);
      if (found.rowCount === 0) {
        die(`没有这个工号:${employeeNo}。若是要新建,请用默认的种子模式。`);
      }
      const password =
        process.env['KC_INIT_PASSWORD'] !== undefined
          ? await resolvePassword('env')
          : await resolvePassword('prompt');
      if (DRY_RUN) {
        warn(`${employeeNo} ${found.rows[0].name} —— 将重置密码并要求改密(现在不动)`);
        return;
      }
      const passwordHash = await hash(password, SALT_ROUNDS);
      await client.query(
        `UPDATE users
            SET password_hash = $2, must_change_password = true, updated_at = now()
          WHERE id = $1`,
        [found.rows[0].id, passwordHash],
      );
      // 留痕。**不写密码本身** —— 审计表是"只增不删"的(§4.2),写进去就永远删不掉了
      await audit(client, null, 'user.seed.passwordReset', 'user', found.rows[0].id, {
        employeeNo,
        // 只记"重置过"这件事,足以追责;不记口令本身
        note: '管理员在服务器上重置,口令不落审计',
      });
      ok(`${employeeNo} ${found.rows[0].name} —— 密码已重置,下次登录会被要求改密`);
    } finally {
      await client.end();
    }
    return;
  }

  // ---- 模式 2:从文件导入 ----
  if (MODE === 'import') {
    die(
      '从文件导入尚未实现。\n' +
        '  账号清单的正确入口是 Excel 导入(界面上的「组织架构 → 下载模板」),\n' +
        '  它会走真实接口、顺带验一遍导入功能。\n' +
        '  这个脚本只负责「建一组固定的演示账号」与「重置单个账号的密码」。',
    );
  }

  // ---- 模式 3:种子(含 --overwrite-users) ----
  const onExisting = OVERWRITE_USERS ? 'overwrite' : DEFAULT_ON_EXISTING;

  /*
   * ⚠️ 密码来源的判定,这里有个**曾经写错的地方**,值得留痕。
   *
   * 原来的三元链是:
   *   env(有环境变量) → prompt(是 TTY) → **preset(兜底给内置 123456)**
   *
   * 那个 `preset` 兜底看起来无害,实际后果是:
   * `docker compose exec -T ...`(非 TTY,自动化最常用的那条命令)
   * **静默地用 123456 当密码**把账号建出来 —— 而脚本还打印
   * "密码来源:内置初始密码",一个不读输出的人根本不会注意到。
   * 那等于给生产发了一批所有人都猜得到的口令。
   *
   * → 所以改成:**只有 dry-run 允许不发密码**(它本来就不写任何东西),
   * 其余情况缺来源就**明确失败**,并把两条出路写出来。
   * 宁可让人多打一个参数,也不能静默降级到弱口令。
   */
  let passwordKind;
  if (DRY_RUN) {
    // dry-run 不写,所以也不需要真密码 —— 但要说清"真跑起来会用什么",
    // 否则 dry-run 的输出会给人虚假的安全感。
    passwordKind = hasEnvPassword() ? 'env' : stdin.isTTY ? 'prompt' : 'preset';
  } else if (hasEnvPassword()) {
    passwordKind = 'env';
  } else if (stdin.isTTY) {
    passwordKind = 'prompt';
  } else {
    die(
      '没有可用的密码来源,而这次操作**会创建账号**。\n' +
        '  两条出路,选一条:\n' +
        '    ① 交互式执行(密码输入不回显、不落盘):\n' +
        '         docker compose exec api node scripts/admin-init.mjs   ← 注意**不要加 -T**\n' +
        '    ② 用环境变量传:\n' +
        '         docker compose exec -e KC_INIT_PASSWORD=... api node scripts/admin-init.mjs\n' +
        '  刻意**不**提供「内置默认密码」这个兜底 —— 那等于给生产发一批\n' +
        '  所有人都猜得到的口令,而脚本自己还报告「成功」。',
    );
  }

  log('');
  log(`  模式      : ${OVERWRITE_USERS ? '⚠ 覆盖已存在账号' : '只新建,不碰已存在'}`);
  log(`  密码来源  : ${describePasswordSource(passwordKind)}`);
  log(`  账号数量  : ${String(SEED_ACCOUNTS.length)}`);

  if (OVERWRITE_USERS) {
    log('');
    log('  ⚠⚠⚠ 你传了 --overwrite-users ⚠⚠⚠');
    log('  这会**重置已存在账号的密码**。生产环境里 KC002 可能已经是某个真的部长,');
    log('  一旦被重置,他的口令就变了,而他本人不会知道。');
    log('  除非你确定这是测试库,否则请去掉这个参数。');
    if (!(await confirmDestructive())) {
      process.exit(0);
    }
  }

  const client = await connect();
  try {
    log('');
    log('账号:');
    const ids = new Map();
    for (const account of SEED_ACCOUNTS) {
      // ⚠️ 一律用同一个密码算 hash:每账号算一次 bcrypt 是纯浪费
      // (10 rounds ≈ 60ms,而这里要做 5 次)。
      // 安全性不受影响 —— bcrypt 靠 salt 区分,相同明文不会得到相同 hash。
      const password = await resolvePassword(passwordKind);
      const result = await upsertAccount(client, account, password, onExisting);
      if (result.id !== undefined) ids.set(account.employeeNo, result.id);
    }

    if (DRY_RUN) {
      log('');
      log('(dry-run 结束:没有任何改动)');
      return;
    }

    // ---- 组织架构 ----
    log('');
    log('组织架构:');
    const nodeIds = await ensureNodes(client, ids, DRY_RUN);

    // ---- 归属 ----
    log('');
    log('组织归属:');
    for (const account of SEED_ACCOUNTS) {
      for (const title of account.assignedTo ?? []) {
        const nodeId = nodeIds.get(title);
        const userId = ids.get(account.employeeNo);
        if (nodeId === undefined || userId === undefined) continue;
        const existing = await client.query(
          `SELECT 1 FROM org_assignments WHERE user_id = $1 AND node_id = $2`,
          [userId, nodeId],
        );
        if (existing.rowCount > 0) {
          ok(`${account.employeeNo} → ${title} —— 已有,未动`);
          continue;
        }
        if (DRY_RUN) {
          warn(`${account.employeeNo} → ${title} —— 将新增`);
          continue;
        }
        await client.query(`INSERT INTO org_assignments (user_id, node_id) VALUES ($1, $2)`, [
          userId,
          nodeId,
        ]);
        ok(`${account.employeeNo} → ${title} —— 已加入`);
      }
    }

    await audit(client, null, 'user.seed.init', 'user', null, {
      accounts: SEED_ACCOUNTS.map((a) => a.employeeNo),
      onExisting,
      // ⚠️ 密码绝不进 detail:审计表只增不删,写进去就永久留下了
      passwordSource: passwordKind,
      note: '密码不落审计',
    });

    log('');
    log('='.repeat(56));
    log('完成。接下来:');
    log('  · 每个账号用**工号**登录(不是姓名);');
    log('  · 标了「首登要改密」的账号,用初始密码登录后会被要求改密,');
    log('    改完**必须用新密码再登录一次**才进得去 —— 这是§6.1.2 的规定,不是故障;');
    log('  · ⚠️ 这是**演示数据**。正式使用前请把口令换成你们自己的,');
    log('    并把不再需要的账号在「人员」里改成「已停用」。');
  } finally {
    await client.end();
  }
}

/**
 * 造出种子需要的那棵树(部门 / 组 / 文档),返回 标题 → id。
 *
 * ⚠️ **物化路径必须逐层实时算,不能最后统一补。**
 * `materialized_path` 与 `depth` 是权限判定的地基(§5.5):
 * `PermissionService.chainOf` 靠它取祖先链,算错了就是**静默的越权或失权**。
 *
 * 而它只能在**父节点已存在**时才算得出来 ——
 * 所以插入顺序必须严格「先父后子」,每插一个就把它真实的 path 记下来。
 * 之前那版想"最后用递归 CTE 统一重算",有两个问题:
 *   1. 它让 `materialized_path` 在插入期间处于**空值**,而 CHECK 约束与
 *      唯一索引都可能在这段窗口里拒绝插入 —— 报出来的错会指向错误的行;
 *   2. 更要紧的是,一旦脚本中途失败,库里就留下一批 path 为空的节点,
 *      而那批数据**能通过所有现有门禁**(现有检查不查这个不变式,
 *      P1-5 之后才加)。宁可一开始就写对。
 */
async function ensureNodes(client, userIds, dryRun) {
  const nodeIds = new Map();
  const paths = new Map();

  const create = async (title, parentTitle, ownerEmployeeNo, kind, depth) => {
    const found = await client.query(`SELECT id FROM nodes WHERE title = $1`, [title]);
    if (found.rowCount > 0) {
      nodeIds.set(title, found.rows[0].id);
      const row = await client.query(`SELECT materialized_path FROM nodes WHERE id = $1`, [
        found.rows[0].id,
      ]);
      paths.set(title, row.rows[0]?.materialized_path ?? null);
      ok(`「${title}」—— 已存在`);
      return;
    }

    if (dryRun) {
      warn(`「${title}」—— 将新建`);
      return;
    }

    /*
     * ⚠️ 路径里必须嵌**自己的 id**,而 id 是 `gen_random_uuid()` 生成的 ——
     * 所以先在应用侧把 id 取出来,再**一次**插入就写对。
     *
     * 之前那版是"插入时写 PLACEHOLDER、拿到 id 再 UPDATE" ——
     * 那会在库里留下一条**内容错误的数据**(path 末段是字面量 PLACEHOLDER),
     * 而它能通过所有门禁(没有一处检查"path 的最后一段等于 id")。
     * 那种"先写个错的再改对"的做法,一旦第二步失败就留下了脏数据。
     *
     * → 自己生成 uuid 就没有第二次写,也就没有那个窗口。
     */
    const newId = randomUUID();
    const parentPath = parentTitle === null ? null : (paths.get(parentTitle) ?? null);
    const realPath = parentPath === null ? `/${newId}` : `${parentPath}/${newId}`;
    const ownerId = ownerEmployeeNo === undefined ? null : (userIds.get(ownerEmployeeNo) ?? null);

    await client.query(
      `INSERT INTO nodes (id, title, kind, parent_id, owner_id, created_by,
                          materialized_path, depth, position)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 0)`,
      [
        newId,
        title,
        kind,
        parentTitle === null ? null : (nodeIds.get(parentTitle) ?? null),
        ownerId,
        realPath,
        depth,
      ],
    );

    nodeIds.set(title, newId);
    paths.set(title, realPath);
    ok(`「${title}」—— 已新建`);
  };

  // 顺序即依赖:先全部一级,再二级,再文档。
  for (const dept of SEED_DEPARTMENTS) {
    await create(dept.title, null, dept.ownerEmployeeNo, 'space', 0);
  }
  for (const sub of SEED_SUB_NODES) {
    await create(sub.title, sub.parentTitle, sub.ownerEmployeeNo, 'space', 1);
  }
  for (const doc of SEED_DOCUMENTS) {
    await create(doc.title, doc.parentTitle, doc.ownerEmployeeNo, 'document', 1);
  }

  return nodeIds;
}

/** 写审计。⚠️ 调用方负责确保 detail 里没有密码。 */
async function audit(client, actorId, action, targetType, targetId, detail) {
  try {
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, action, targetType, targetId, JSON.stringify(detail)],
    );
  } catch {
    // 审计写不进去**不能**让初始化失败 —— 它是元数据,不是主任务
    warn('审计记录写入失败(不影响初始化结果,但请人工补记)');
  }
}

await main();
