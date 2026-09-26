import { Injectable } from '@nestjs/common';
import {
  type AuthUser,
  type MeResponse,
  type MyScope,
  checkPasswordStrength,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { AppError } from '../common/errors/app-error.js';
import { idsOfPath, renderPath } from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SetupDto } from './dto/setup.dto.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionMeta } from './session.service.js';

/** 对外可见的用户字段。**不含** passwordHash。 */
const USER_PUBLIC_SELECT = {
  id: true,
  employeeNo: true,
  name: true,
  avatarColor: true,
  isSuperAdmin: true,
  status: true,
  mustChangePassword: true,
} satisfies Prisma.UserSelect;

/** 认证内部才需要的字段(多一个密码哈希)。 */
const USER_AUTH_SELECT = {
  ...USER_PUBLIC_SELECT,
  passwordHash: true,
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_PUBLIC_SELECT }>;

export interface IssuedAuth {
  user: AuthUser;
  token: string;
  expiresAt: Date;
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
 * 4. **强制改密的拦截在守卫里,不在这里** —— 登录本身**允许**成功(否则用户
 *    连改密页都进不去)。拦截发生在后续每个请求上(§6.1.2)。
 */
@Injectable()
export class AuthService {
  /** 时序对齐用的假哈希,首次需要时才计算并缓存。 */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
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

    const user = await this.prisma.$transaction(async (tx) => {
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
   * ⚠️ 登录**允许**在 `mustChangePassword` 为真时成功 —— 否则用户连改密页都进不去。
   * 真正的拦截在 `AuthGuard` 里(§6.1.2)。
   */
  async login(input: LoginDto, meta: SessionMeta): Promise<IssuedAuth> {
    const user = await this.prisma.user.findUnique({
      where: { employeeNo: input.employeeNo },
      select: USER_AUTH_SELECT,
    });

    // 工号不存在时也消耗一次同等级别的 bcrypt 计算,抹平时序差异(见类注释第 2 条)。
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.passwords.verify(input.password, hashToCheck).catch(() => false);

    if (user === null || !passwordOk || user.status !== 'active') {
      // 同一句话、同一个状态码,不给枚举者任何区分依据。
      throw new AppError('UNAUTHORIZED', '工号或密码不正确');
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
    return { user: toAuthUser(user), token: session.token, expiresAt: session.expiresAt };
  }

  /**
   * 改密(首登强制改密与主动改密共用)。
   *
   * 三条约束:
   *   - 必须提供当前密码(会话可能被接管)
   *   - 新密码要过 `checkPasswordStrength`(≥8 位 + 字母数字)
   *   - 新密码不能与当前密码相同(否则"强制改密"等于没改)
   *
   * **不吊销其他会话**:首登改密后如果被踢回登录页,用户会以为是故障。
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
   * 由会话 token 还原出当前用户。守卫每个请求都会走这里。
   * 返回 null 一律按「未登录」处理。
   */
  async resolveUserBySessionToken(token: string): Promise<AuthUser | null> {
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

    return toAuthUser(user);
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
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    avatarColor: row.avatarColor,
    isSuperAdmin: row.isSuperAdmin,
    status: toUserStatus(row.status),
    mustChangePassword: row.mustChangePassword,
  };
}

/** 库里可能存着历史值,收敛成合法状态;未知一律按「在职」以外的最保守值处理。 */
function toUserStatus(value: string): AuthUser['status'] {
  if (value === 'active' || value === 'disabled' || value === 'departed') return value;
  return 'disabled';
}
