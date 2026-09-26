import { Injectable } from '@nestjs/common';
import {
  type AuthUser,
  type MeResponse,
  type VisibleSpace,
  isSpaceRole,
  type SpaceRole,
} from '@knowledgecool/shared';

import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SetupDto } from './dto/setup.dto.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionMeta } from './session.service.js';

/** 对外可见的用户字段。**不含** passwordHash 与 status。 */
const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  department: true,
  avatarColor: true,
  isSuperAdmin: true,
} satisfies Prisma.UserSelect;

/** 认证内部才需要的字段。 */
const USER_AUTH_SELECT = {
  ...USER_PUBLIC_SELECT,
  passwordHash: true,
  status: true,
} satisfies Prisma.UserSelect;

interface UserRow {
  id: string;
  email: string;
  name: string;
  department: string | null;
  avatarColor: string;
  isSuperAdmin: boolean;
}

export interface IssuedAuth {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

/**
 * 认证核心。
 *
 * 三条刻意的安全设计:
 *  1. **不区分「邮箱不存在」与「密码错误」** —— 都返回同一个 401 与同一句文案。
 *     否则登录接口就成了账号枚举器(呼应 §5.3「最小可见」)。
 *  2. **邮箱不存在时也跑一次 bcrypt 校验** —— 否则「响应很快」本身就等于
 *     「这个邮箱没注册」,时序侧信道同样能枚举账号。
 *  3. **账号被停用时顺手吊销其全部会话** —— status 改掉后,已发的会话不能继续用。
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
   * 首次初始化:创建超管并直接登录(DESIGN.md §6.2,仅当库中无用户时可用)。
   *
   * 并发下的正确性:两个请求同时到达时,必须只有一个能成功。
   * 因此把「再查一次是否为空」放进事务里 —— 事务外那次检查只是为了快速失败,
   * 不作为依据。
   */
  async setup(input: SetupDto, meta: SessionMeta): Promise<IssuedAuth> {
    if (await this.isInitialized()) {
      throw AppError.forbidden('系统已完成初始化,不能重复创建首位管理员');
    }

    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.prisma.$transaction(async (tx) => {
      if ((await tx.user.count()) > 0) {
        throw AppError.forbidden('系统已完成初始化,不能重复创建首位管理员');
      }

      return tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          isSuperAdmin: true,
        },
        select: USER_PUBLIC_SELECT,
      });
    });

    const session = await this.sessions.issue(user.id, meta);
    return { user: toAuthUser(user), token: session.token, expiresAt: session.expiresAt };
  }

  async login(input: LoginDto, meta: SessionMeta): Promise<IssuedAuth> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: USER_AUTH_SELECT,
    });

    // 邮箱不存在时也消耗一次同等级别的 bcrypt 计算,抹平时序差异(见类注释第 2 条)。
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.passwords.verify(input.password, hashToCheck).catch(() => false);

    if (user === null || !passwordOk || user.status !== 'active') {
      // 同一句话、同一个状态码,不给枚举者任何区分依据。
      throw new AppError('UNAUTHORIZED', '邮箱或密码不正确');
    }

    const session = await this.sessions.issue(user.id, meta);
    return { user: toAuthUser(user), token: session.token, expiresAt: session.expiresAt };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
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
      // 账号已停用或被删除:连带清掉它的全部会话,避免残留可用登录态。
      await this.sessions.revokeAllForUser(session.userId);
      return null;
    }

    return toAuthUser(user);
  }

  /** `GET /auth/me` —— 当前用户 + 可见空间列表(§6.2)。 */
  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_PUBLIC_SELECT,
    });

    if (user === null) {
      // 会话有效但用户没了 —— 按 §6.1 的 NOT_FOUND 语义返回,不额外解释。
      throw AppError.notFound();
    }

    const memberships = await this.prisma.spaceMember.findMany({
      where: { userId },
      select: {
        role: true,
        space: { select: { id: true, name: true, slug: true, letter: true, color: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const spaces: VisibleSpace[] = [];
    for (const membership of memberships) {
      const role = toSpaceRole(membership.role);
      // 角色值异常时**跳过**该空间而不是兜底成某个角色 —— 权限相关的兜底
      // 永远应该偏向「不给」,而不是「给一个猜的」。
      if (role === null) continue;
      spaces.push({ ...membership.space, role });
    }

    return { user: toAuthUser(user), spaces };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash('kc::timing-equalization::not-a-real-password');
    return this.dummyHash;
  }
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    department: row.department,
    avatarColor: row.avatarColor,
    isSuperAdmin: row.isSuperAdmin,
  };
}

/** 把库里的字符串收敛成合法空间角色;未知值返回 null(由调用方跳过)。 */
function toSpaceRole(value: string): SpaceRole | null {
  return isSpaceRole(value) ? value : null;
}
