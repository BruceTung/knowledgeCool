import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AuthUser,
  type InitialPasswordInput,
  type LoginResponse,
  type MeResponse,
  type MyScope,
  checkPasswordStrength,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { isUniqueViolation, runSerializable } from '../common/db/serializable.js';
import { AppError } from '../common/errors/app-error.js';
import { idsOfPath, renderPath } from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SetupDto } from './dto/setup.dto.js';
import { LoginThrottleService, lockMessage } from './login-throttle.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionMeta } from './session.service.js';
import { signSetupToken, verifySetupToken } from './setup-token.js';

/** 对外可见的用户字段。**不含** passwordHash,也不含 mustChangePassword。 */
const USER_PUBLIC_SELECT = {
  id: true,
  employeeNo: true,
  name: true,
  avatarColor: true,
  isSuperAdmin: true,
  status: true,
} satisfies Prisma.UserSelect;

/** 认证内部才需要的字段(多一个密码哈希 + 待改密标记)。 */
const USER_AUTH_SELECT = {
  ...USER_PUBLIC_SELECT,
  passwordHash: true,
  mustChangePassword: true,
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_PUBLIC_SELECT }>;

/**
 * 守卫用的用户画像 —— 比 `AuthUser` 多一个"是否待改密"。
 *
 * ⚠️ 这个字段**只在服务端有意义**:能拿到 `AuthUser` 的前端,
 * 手里必然已经有会话,而首登不发会话 —— 所以前端看到的它恒为 false。
 * 放到 `AuthUser` 里等于给前端一个永远为假的字段。
 */
export interface SessionUser extends AuthUser {
  mustChangePassword: boolean;
}

export interface IssuedAuth {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

/**
 * 登录的**服务端**结果。
 *
 * 为什么不让 service 直接返回 `LoginResponse`:会话 token 只应该走
 * HttpOnly Cookie,**绝不能出现在响应体里**。把它放在 `session` 这个
 * 独立字段上,controller 一眼就能看出"这个值不进 JSON"——
 * 而如果把它塞进 `response` 里,某天有人加个 `console.log(response)` 就漏了。
 */
export interface LoginOutcome {
  /** 要返回给前端的响应体 */
  response: LoginResponse;
  /** 只有**真正建立了会话**时才有。首登改密那条路径没有。 */
  session?: { token: string; expiresAt: Date };
}

/**
 * 认证核心。
 *
 * 四条刻意的安全设计:
 *
 * 1. **不区分「工号不存在」与「密码错误」** —— 都返回同一个 401 与同一句文案。
 *    否则登录接口就成了账号枚举器 —— 而工号是可预测的(往往就是连号),
 *    这个风险比邮箱还高。
 * 2. **工号不存在时也跑一次 bcrypt 校验** —— 否则"响应很快"本身就等于
 *    "这个工号没注册",时序侧信道同样能枚举账号。
 * 3. **账号被停用 / 离职时顺手吊销其全部会话** —— status 改掉后,已发的会话不能继续用。
 * 4. **首次登录不建立会话**(v2.4 重做)—— 只签一张 10 分钟的一次性凭证。
 *    改密之前这个人**没有登录状态**,所以不存在"已登录但未改密"这种
 *    半登录态;守卫里那套"改密白名单"也一并删掉了(§6.1.2)。
 */
@Injectable()
export class AuthService {
  /** 时序对齐用的假哈希,首次需要时才计算并缓存。 */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    private readonly throttle: LoginThrottleService,
  ) {}

  /** 库中是否已有用户。`/auth/setup` 与前端引导页都靠它判断。 */
  async isInitialized(): Promise<boolean> {
    return (await this.prisma.user.count()) > 0;
  }

  /**
   * 首次初始化:创建超管并直接登录(仅当库中无用户时可用)。
   *
   * 并发下的正确性:两个请求同时到达时必须只有一个能成功,
   * 所以把「再查一次是否为空」放进事务 —— 事务外那次检查只为快速失败,不作依据。
   *
   * ⚠️⚠️ **事务必须是 Serializable**(v4.8 修)。原来这里用的是
   * `$transaction`,而它的默认隔离级别是 **READ COMMITTED** ——
   * 在这个级别下,两个并发请求各自 `count()` 都读到 0(互相看不见对方
   * 那个还没提交的 INSERT),于是**两边都能提交,库里出现两个超管**。
   * 原注释声称"只有一个能成功",那句话在 READ COMMITTED 下是不成立的:
   * 快照隔离只能保证"读不到未提交的写",保证不了"读到的不会被别人改"。
   * 这类"先数一数、再写"的形状正是 `runSerializable` 存在的理由
   * (见 `common/db/serializable.ts` 开头的说明),仓库别处都走它。
   *
   * 另一道兜底是 `employeeNo` 上的唯一约束:即便两个名字不同的请求错开
   * 提交窗口,同工号也会撞 P2002。那时它被映射成与"已初始化"同一个 403
   * —— 否则会漏出一个 500,并且告诉调用方"这个工号已存在"(等于确认了
   * 系统已经初始化过,而这一步本该是原子的)。
   *
   * 首个管理员的密码是他**自己设的**,不是内置初始密码,所以
   * `mustChangePassword` 为 `false`。
   */
  async setup(input: SetupDto, meta: SessionMeta): Promise<IssuedAuth> {
    if (await this.isInitialized()) {
      throw AppError.forbidden('系统已完成初始化,不能重复创建首位管理员');
    }

    const problem = checkPasswordStrength(input.password);
    if (problem !== null) throw AppError.validation(problem);

    const passwordHash = await this.passwords.hash(input.password);

    const user = await runSerializable(this.prisma, async (tx) => {
      if ((await tx.user.count()) > 0) {
        throw AppError.forbidden('系统已完成初始化,不能重复创建首位管理员');
      }

      return tx.user.create({
        data: {
          employeeNo: input.employeeNo,
          name: input.name,
          passwordHash,
          isSuperAdmin: true,
          mustChangePassword: false,
        },
        select: USER_PUBLIC_SELECT,
      });
    }).catch((error: unknown) => {
      // 同工号撞唯一约束:并发下它同样意味着"已经有人抢先建好了首位管理员",
      // 所以对外与"已初始化"是同一件事,不能漏成 500。
      if (isUniqueViolation(error)) {
        throw AppError.forbidden('系统已完成初始化,不能重复创建首位管理员');
      }
      throw error;
    });

    const session = await this.sessions.issue(user.id, meta);
    await this.touchLastLogin(user.id);
    await recordAudit(this.prisma, {
      actorId: user.id,
      action: 'auth.setup',
      targetType: 'user',
      targetId: user.id,
      detail: { employeeNo: user.employeeNo },
      ip: meta.ip ?? null,
    });
    return { user: toAuthUser(user), token: session.token, expiresAt: session.expiresAt };
  }

  /**
   * 登录。
   *
   * ## ⚠️ 首次登录**不建立会话**(v2.4 重做)
   *
   * `mustChangePassword` 为真时:不写 Cookie、不产生 `sessions` 行,
   * 只返回一个一次性 `setupToken` 让前端去走改密页。
   *
   * 旧实现是"先发会话、再由守卫拦住所有业务接口",结果是这个人卡在一个
   * **半登录态**:进不去系统,也退不出去(连登录页都回不去)。
   * 用户的原话:「用户第一次登录,不应该记录登录状态,
   * 重置完密码以后,应该要用户重新登录才对」。
   *
   * 现在改密之前**没有登录状态**可言 —— 只有一张 10 分钟的一次性凭证。
   *
   * 顺带的好处:守卫里那套"改密白名单"整个不需要了
   * (见 `AuthGuard` —— 不再存在"已登录但未改密"这种状态)。
   */
  async login(input: LoginDto, meta: SessionMeta): Promise<LoginOutcome> {
    const ip = meta.ip ?? null;

    // 限流闸放在**最前面**,而且锁定期间**根本不校验密码** ——
    // 放在 bcrypt 之后的话,锁定期仍然会跑一次哈希,等于锁定只挡了结果没挡开销;
    // 而且"被锁"与"密码错"的耗时差异又能被用来枚举账号。
    //
    // ⚠️ 计数键用工号,不管它存不存在 —— 所以"被锁定"这个响应本身
    // 不构成账号枚举(见 login-throttle.ts 的设计说明第 1 条)。
    const verdict = await this.throttle.check(input.employeeNo, ip);
    if (verdict.locked) {
      throw new AppError('RATE_LIMITED', lockMessage(verdict.retryAfterSeconds), {
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { employeeNo: input.employeeNo },
      select: USER_AUTH_SELECT,
    });

    // 工号不存在时也消耗一次同等级别的 bcrypt 计算,抹平时序差异(见类注释第 2 条)。
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.passwords.verify(input.password, hashToCheck).catch(() => false);

    if (user === null || !passwordOk || user.status !== 'active') {
      const outcome = await this.throttle.recordFailure(input.employeeNo, ip);

      // 只在**账号真实存在**时留痕。否则任何未登录的人都可以用捏造的工号
      // 往审计表里灌数据 —— 审计是"只写不删"的,污染它比缺一条记录更糟。
      if (outcome.locked && user !== null) {
        await recordAudit(this.prisma, {
          actorId: null,
          action: 'auth.login.locked',
          targetType: 'user',
          targetId: user.id,
          detail: { employeeNo: user.employeeNo, retryAfterSeconds: outcome.retryAfterSeconds },
          ip,
        });
      }

      // 同一句话、同一个状态码,不给枚举者任何区分依据。
      throw new AppError('UNAUTHORIZED', '工号或密码不正确');
    }

    // 成功了就把这个账号的失败计数与锁清掉,免得零星几次打错累积成"某天突然被锁"。
    await this.throttle.recordSuccess(input.employeeNo);

    if (user.mustChangePassword) {
      const { token, expiresAt } = signSetupToken(user.id, this.requireSessionSecret());

      await recordAudit(this.prisma, {
        actorId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        detail: { employeeNo: user.employeeNo, passwordChangeRequired: true },
        ip: meta.ip ?? null,
      });

      // 刻意**不**记 `lastLoginAt`:他还没进过系统。
      // 那个字段的语义是"上次真正进入系统的时间",把"验证了初始密码"算进去
      // 会让"这批人到底有没有登录过"这个问题失去意义。
      return {
        response: {
          kind: 'password-change-required',
          employeeNo: user.employeeNo,
          name: user.name,
          setupToken: token,
          setupTokenExpiresAt: expiresAt.toISOString(),
        },
      };
    }

    const session = await this.sessions.issue(user.id, meta);
    await this.touchLastLogin(user.id);
    await recordAudit(this.prisma, {
      actorId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      detail: { employeeNo: user.employeeNo },
      ip: meta.ip ?? null,
    });
    return {
      response: {
        kind: 'session',
        user: toAuthUser(user),
        expiresAt: session.expiresAt.toISOString(),
      },
      // token 走这个字段 → controller 拿去写 Cookie,**不进响应体**
      session: { token: session.token, expiresAt: session.expiresAt },
    };
  }

  /**
   * 首次改密 —— 凭登录时拿到的一次性凭证,**不要当前密码**。
   *
   * 不要当前密码是刻意的:登录那一步已经用初始密码验过身份,再要一次是重复。
   * 凭证本身一次性、10 分钟过期、只对签发它的用户有效。
   *
   * 三道校验,少一道都不行:
   *   1. 凭证签名有效且未过期
   *   2. 用户**仍然**处于"需要改密"状态 —— 已经改过就不该再用
   *      (这就是"一次性"的落地方式:不需要服务端记录"用过了",
   *       状态本身已经把凭证作废了)
   *   3. 新密码过强度校验
   *
   * ⚠️ **改完不建立会话。** 用户必须用新密码重新登录一次 ——
   * 这样"我设的密码真的能用"是当场验证的,而不是等他下次来才发现打错了。
   */
  async setInitialPassword(input: InitialPasswordInput): Promise<void> {
    const userId = verifySetupToken(input.setupToken, this.requireSessionSecret());
    if (userId === null) {
      throw new AppError('UNAUTHORIZED', '改密凭证无效或已过期,请重新登录');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, mustChangePassword: true },
    });
    if (user === null || user.status !== 'active') {
      throw new AppError('UNAUTHORIZED', '账号状态异常,请联系管理员');
    }
    if (!user.mustChangePassword) {
      throw new AppError('UNAUTHORIZED', '密码已经修改过,请直接用新密码登录');
    }

    const problem = checkPasswordStrength(input.newPassword);
    if (problem !== null) throw AppError.validation(problem);

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });

    await recordAudit(this.prisma, {
      actorId: userId,
      action: 'auth.password.change',
      targetType: 'user',
      targetId: userId,
      detail: { forced: true, method: 'initial-token' },
    });
  }

  /**
   * 已登录用户主动改密。
   *
   * ⚠️ 与首次改密(`setInitialPassword`)是**两条不同的路径**:
   *   - 这条:已登录 + 提供当前密码(会话可能被他人接管,多要一次密码能挡住一部分)
   *   - 首登:未登录 + 提供一次性凭证(见 `setInitialPassword`)
   *
   * 三条约束:
   *   - 必须提供当前密码
   *   - 新密码要过 `checkPasswordStrength`(≥8 位 + 字母数字)
   *   - 新密码不能与当前密码相同
   *
   * **不吊销其他会话**:用户主动改密之后如果被踢回登录页,他会以为是故障。
   * 要"改密即下线所有设备"是一个独立的安全开关,不放在这里顺手做掉。
   */
  async changePassword(userId: string, input: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_AUTH_SELECT,
    });
    if (user === null) throw AppError.notFound();

    const ok = await this.passwords
      .verify(input.currentPassword, user.passwordHash)
      .catch(() => false);
    if (!ok) throw new AppError('UNAUTHORIZED', '当前密码不正确');

    const problem = checkPasswordStrength(input.newPassword);
    if (problem !== null) throw AppError.validation(problem);

    if (input.newPassword === input.currentPassword) {
      throw AppError.validation('新密码不能与当前密码相同');
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });

    await recordAudit(this.prisma, {
      actorId: userId,
      action: 'auth.password.change',
      targetType: 'user',
      targetId: userId,
      detail: { forced: user.mustChangePassword },
    });
  }

  /**
   * 登出。
   *
   * `actorId` 是可选的:审计里"谁登出了"比"有一次登出"有用得多,
   * 但会话 token 本身不携带用户 id,所以由调用方(controller)传进来。
   */
  async logout(token: string, actorId: string | null = null): Promise<void> {
    await this.sessions.revoke(token);
    await recordAudit(this.prisma, {
      actorId,
      action: 'auth.logout',
      targetType: 'user',
      targetId: actorId ?? '(unknown)',
      detail: {},
    });
  }

  /**
   * 只吊销会话,不写审计。
   *
   * 用途:`AuthGuard` 的纵深防御分支 —— 遇到"有会话但还待改密"的异常状态时
   * 把会话清掉。那条路径**不是**用户主动登出,记成 `auth.logout` 会让审计里
   * 多出一批莫名其妙的登出记录,反而掩盖真实情况。
   */
  async revokeSession(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /**
   * 由会话 token 还原出当前用户。守卫每个请求都会走这里。
   * 返回 null 一律按「未登录」处理。
   *
   * 返回的是 `SessionUser`(比 `AuthUser` 多一个 `mustChangePassword`)——
   * 守卫要用它做纵深防御检查,但**不会**把这个字段交给前端。
   */
  async resolveUserBySessionToken(token: string): Promise<SessionUser | null> {
    const session = await this.sessions.resolve(token);
    if (session === null) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: USER_AUTH_SELECT,
    });

    if (user === null || user.status !== 'active') {
      // 账号已停用 / 已离职 / 被删除:连带清掉它的全部会话,避免残留可用登录态。
      // ⚠️ `departed`(离职)也必须挡在这里 —— 离职的人不能再登进系统。
      await this.sessions.revokeAllForUser(session.userId);
      return null;
    }

    return { ...toAuthUser(user), mustChangePassword: user.mustChangePassword };
  }

  /**
   * `GET /auth/me` —— 当前用户 + 组织归属(§6.2)。
   *
   * ⚠️ 返回的是**组织归属**,不再是"可见空间列表" ——
   * 所有节点对所有人可见,没有"可见子集"这回事。
   */
  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_PUBLIC_SELECT,
    });

    if (user === null) {
      // 会话有效但用户没了 —— 按 NOT_FOUND 语义返回,不额外解释。
      throw AppError.notFound();
    }

    const assignments = await this.prisma.orgAssignment.findMany({
      where: { userId },
      select: { node: { select: { id: true, materializedPath: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const scopes = await this.renderScopes(assignments.map((row) => row.node));
    return { user: toAuthUser(user), scopes };
  }

  // ---------------- 私有 ----------------

  /** 把归属节点的 id 路径渲染成 `技术部 / 后端组`。一条查询取全部标题,不做 N+1。 */
  private async renderScopes(
    nodes: readonly { id: string; materializedPath: string }[],
  ): Promise<MyScope[]> {
    if (nodes.length === 0) return [];

    const ids = new Set<string>();
    for (const node of nodes) {
      for (const id of idsOfPath(node.materializedPath)) ids.add(id);
    }

    const rows = await this.prisma.node.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true },
    });
    const titles = new Map(rows.map((row) => [row.id, row.title]));

    return nodes.map((node) => ({
      nodeId: node.id,
      path: renderPath(node.materializedPath, titles),
    }));
  }

  /**
   * 记录本次登录时间。
   *
   * **写失败不应该让登录失败** —— 它只是审计元数据,不是认证的必要条件,
   * 所以这里吞掉异常而不是把一次成功登录变成 500。
   */
  private async touchLastLogin(userId: string): Promise<void> {
    await this.prisma.user
      .update({ where: { id: userId }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash('kc::timing-equalization::not-a-real-password');
    return this.dummyHash;
  }

  /**
   * 取凭证签名密钥。**未配置时不降级,直接报错。**
   *
   * 用空字符串当密钥去签,等于任何人都能伪造凭证 ——
   * 那比"首登改密暂时不可用"严重得多。宁可让它显式失败、让运维去补配置。
   */
  private requireSessionSecret(): string {
    const secret = this.config.get<string>('sessionSecret') ?? '';
    if (secret === '') {
      throw new AppError(
        'INTERNAL_ERROR',
        '服务端未配置 SESSION_SECRET,首次改密暂时不可用,请联系管理员',
      );
    }
    return secret;
  }
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    avatarColor: row.avatarColor,
    isSuperAdmin: row.isSuperAdmin,
    status: toUserStatus(row.status),
  };
}

/** 库里可能存着历史值,收敛成合法状态;未知一律按「在职」以外的最保守值处理。 */
function toUserStatus(value: string): AuthUser['status'] {
  if (value === 'active' || value === 'disabled' || value === 'departed') return value;
  return 'disabled';
}
