import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  ROLE_RANK,
  can,
  toEffectiveRole,
  toSpaceRole,
  type Actor,
  type AddSpaceMemberInput,
  type Capability,
  type CreateSpaceInput,
  type SpaceMemberView,
  type SpaceMembersResponse,
  type SpaceRole,
  type SpaceSummary,
} from '@knowledgecool/shared';

import { PasswordService } from '../auth/password.service.js';
import { isUniqueViolation, runSerializable } from '../common/db/serializable.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** 建空间/成员时要返回的空间字段。 */
const SPACE_SUMMARY_SELECT = {
  id: true,
  name: true,
  slug: true,
  letter: true,
  color: true,
  ownerId: true,
} satisfies Prisma.SpaceSelect;

/** 成员行的查询形状。`toMemberView` 只认这一份,避免各处手写 select 漂移。 */
const MEMBER_SELECT = {
  role: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      email: true,
      name: true,
      department: true,
      avatarColor: true,
    },
  },
} satisfies Prisma.SpaceMemberSelect;

type MemberRow = Prisma.SpaceMemberGetPayload<{ select: typeof MEMBER_SELECT }>;

/** 空间的基础字段。导出给别的模块(页面模块)复用,免得各自再写一份 select。 */
export type SpaceRow = Prisma.SpaceGetPayload<{ select: typeof SPACE_SUMMARY_SELECT }>;

/** 空间级访问判定的结果。 */
export interface SpaceAccess {
  role: SpaceRole;
  space: SpaceRow;
}

/**
 * 权限判定所需的「操作者」。只取两个字段,便于单测直接构造。
 * 与共享包的 `Actor` 对齐 —— 注意 `AuthUser` 天然满足它。
 */
type Operator = Pick<Actor, 'id' | 'isSuperAdmin'>;

/**
 * 空间与成员服务(DESIGN.md §6.2 的空间接口)。
 *
 * 三条贯穿全文件的规则:
 *
 * 1. **非成员一律 NOT_FOUND,不是 FORBIDDEN。** §5.3「最小可见」要求
 *    不让人察觉「这个空间存在但你没份」。已经是成员但权限不够时,才返回 FORBIDDEN ——
 *    那时空间的存废对方本来就知道。
 * 2. **超管直通**,但范围仅限「按 id 访问单个空间」(救火用途)。
 *    `GET /spaces` 仍只列我自己是成员的空间 —— 组织级超管在阶段一不做全量浏览。
 * 3. **不许出现零管理员的空间。** 降级/移除最后一个管理员会被拒绝;
 *    「所有者」更是既不能降级也不能移除(阶段一没有转移所有权)。
 *    这类检查放在 **Serializable 事务**里做,否则两个并发请求可以把两个管理员同时降掉。
 */
@Injectable()
export class SpaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  // ==================================================================
  // 读
  // ==================================================================

  /** 我可见的空间(即我是成员的空间),含成员数。对应 `GET /spaces`。 */
  async listForUser(operator: Operator): Promise<SpaceSummary[]> {
    const memberships = await this.prisma.spaceMember.findMany({
      where: { userId: operator.id },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        space: {
          select: {
            id: true,
            name: true,
            slug: true,
            letter: true,
            color: true,
            _count: { select: { members: true } },
          },
        },
      },
    });

    const spaces: SpaceSummary[] = [];
    for (const membership of memberships) {
      const role = toSpaceRole(membership.role);
      // 角色值异常时**跳过**该空间而不是兜底成某个角色。
      // 与 auth.service.me 的处理一致:权限相关的兜底永远偏向「不给」。
      if (role === null) continue;
      spaces.push({
        id: membership.space.id,
        name: membership.space.name,
        slug: membership.space.slug,
        letter: membership.space.letter,
        color: membership.space.color,
        role,
        memberCount: membership.space._count.members,
      });
    }
    return spaces;
  }

  /** 成员列表。`viewer` 起即可看。对应 `GET /spaces/:id/members`。 */
  async listMembers(operator: Operator, spaceId: string): Promise<SpaceMembersResponse> {
    const { role, space } = await this.requireVisible(operator, spaceId);

    const rows = await this.prisma.spaceMember.findMany({
      where: { spaceId },
      select: MEMBER_SELECT,
    });

    const members = rows
      .map((row) => toMemberViewOrNull(row, space.ownerId))
      .filter((view): view is SpaceMemberView => view !== null)
      .sort((a, b) => compareMemberViews(a, b, space.ownerId));

    return {
      space: { ...toSpaceSummary(space), role, memberCount: members.length },
      members,
    };
  }

  // ==================================================================
  // 写
  // ==================================================================

  /**
   * 新建空间。创建者同时成为所有者与空间管理员 ——
   * 否则新空间建出来没人能管理它(没有管理员的空空间是个死结)。
   */
  async create(operator: Operator, input: CreateSpaceInput): Promise<SpaceSummary> {
    const name = input.name.trim();

    const slug =
      input.slug ?? (await this.deriveUniqueSlug(name));

    if (input.slug !== undefined) {
      const taken = await this.prisma.space.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      });
      if (taken !== null) {
        throw AppError.validation('该 slug 已被占用,请换一个');
      }
    }

    const row = await this.prisma
      .$transaction(async (tx) => {
        const space = await tx.space.create({
          data: {
            name,
            slug,
            letter: input.letter?.trim() || firstLetter(name),
            color: input.color ?? 'blue',
            ownerId: operator.id,
          },
          select: SPACE_SUMMARY_SELECT,
        });

        // 同事务内建成员行:要么「空间 + 管理员」一起成立,要么都不成立。
        await tx.spaceMember.create({
          data: { spaceId: space.id, userId: operator.id, role: 'admin' },
        });

        return space;
      })
      .catch((error: unknown) => {
        // 并发下两个同名空间可能同时通过上面的唯一性检查,由唯一索引兜底。
        if (isUniqueViolation(error)) {
          throw AppError.validation('该 slug 已被占用,请换一个');
        }
        throw error;
      });

    return { ...toSpaceSummary(row), role: 'admin', memberCount: 1 };
  }

  /**
   * 邀请成员 / 建号后加入。对应 `POST /spaces/:id/members`。
   *
   * 需要 `space.member.manage` 能力(即空间管理员)。
   */
  async addMember(
    operator: Operator,
    spaceId: string,
    input: AddSpaceMemberInput,
  ): Promise<SpaceMemberView> {
    const { space } = await this.requireCapability(operator, spaceId, 'space.member.manage');

    // citext 列本身大小写不敏感,但统一存小写能让展示一致。
    const email = input.email.trim().toLowerCase();

    const user = await this.ensureUserByEmail(email, input);

    const existing = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: user.id } },
      select: { role: true },
    });
    if (existing !== null) {
      throw AppError.validation('该用户已经是本空间成员');
    }

    const row = await this.prisma.spaceMember
      .create({
        data: { spaceId, userId: user.id, role: input.role },
        select: MEMBER_SELECT,
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw AppError.validation('该用户已经是本空间成员');
        }
        throw error;
      });

    const view = toMemberViewOrNull(row, space.ownerId);
    if (view === null) {
      // 刚写入的角色值不可能非法(有 CHECK 约束);真出现说明库被绕过了。
      throw AppError.validation('角色值不合法,写入未生效');
    }
    return view;
  }

  /** 修改成员角色。对应 `PATCH /spaces/:id/members/:userId`。 */
  async updateMemberRole(
    operator: Operator,
    spaceId: string,
    targetUserId: string,
    role: SpaceRole,
  ): Promise<SpaceMemberView> {
    const { space } = await this.requireCapability(operator, spaceId, 'space.member.manage');

    const row = await runSerializable(this.prisma, async (tx) => {
      const target = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: targetUserId } },
        select: { role: true },
      });
      if (target === null) {
        throw AppError.notFound('该用户不是本空间成员');
      }

      // 所有者不可降级:阶段一没有「转移所有权」,降级后空间就失去归属了。
      if (targetUserId === space.ownerId && role !== 'admin') {
        throw AppError.validation('空间所有者不能被降级');
      }

      if (target.role === 'admin' && role !== 'admin') {
        await assertNotLastAdmin(tx, spaceId);
      }

      return tx.spaceMember.update({
        where: { spaceId_userId: { spaceId, userId: targetUserId } },
        data: { role },
        select: MEMBER_SELECT,
      });
    });

    const view = toMemberViewOrNull(row, space.ownerId);
    if (view === null) throw AppError.notFound('该用户不是本空间成员');
    return view;
  }

  /** 移除成员。对应 `DELETE /spaces/:id/members/:userId`。 */
  async removeMember(operator: Operator, spaceId: string, targetUserId: string): Promise<void> {
    const { space } = await this.requireCapability(operator, spaceId, 'space.member.manage');

    if (targetUserId === space.ownerId) {
      throw AppError.validation('空间所有者不能被移除');
    }

    await runSerializable(this.prisma, async (tx) => {
      const target = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: targetUserId } },
        select: { role: true },
      });
      if (target === null) {
        throw AppError.notFound('该用户不是本空间成员');
      }

      if (target.role === 'admin') {
        await assertNotLastAdmin(tx, spaceId);
      }

      await tx.spaceMember.delete({
        where: { spaceId_userId: { spaceId, userId: targetUserId } },
      });
    });

    // 说明:这里**不**吊销对方会话。会话是全站级的,移出一个空间不该把人踢下线;
    // 权限在每次请求时按成员行现算,所以移出生效是即时的(§6.1.1 的「可吊销」说的是
    // 停用账号那类场景)。
  }

  // ==================================================================
  // 私有:鉴权与事务
  // ==================================================================

  /**
   * 断言操作者「看得见」这个空间。
   * 非成员返回 NOT_FOUND 而不是 FORBIDDEN —— §5.3「最小可见」。
   */
  private async requireVisible(
    operator: Operator,
    spaceId: string,
  ): Promise<{ role: SpaceRole; space: SpaceRow }> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: SPACE_SUMMARY_SELECT,
    });
    if (space === null) throw AppError.notFound();

    if (operator.isSuperAdmin) {
      // 超管直通,有效角色按 §5.2 视为 admin(调用方须写审计日志 —— M5 落地)。
      return { role: 'admin', space };
    }

    const membership = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: operator.id } },
      select: { role: true },
    });
    const role = membership === null ? null : toSpaceRole(membership.role);

    if (role === null) throw AppError.notFound();
    return { role, space };
  }

  /**
   * 断言操作者具备某能力。能力矩阵来自 shared/roles.ts,不在这里手写 if 判断。
   *
   * **公开给其他模块复用**(页面模块就是这么用的):权限判定只应该有一处实现,
   * 否则迟早会有一处漏掉超管直通或「最小可见」的 NOT_FOUND 语义。
   */
  async requireCapability(
    operator: Operator,
    spaceId: string,
    capability: Capability,
  ): Promise<SpaceAccess> {
    const context = await this.requireVisible(operator, spaceId);
    if (!can(toEffectiveRole(context.role), capability)) {
      throw AppError.forbidden('需要空间管理员权限');
    }
    return context;
  }

  /**
   * 邮箱已注册就直接用;没注册就用 name + password 建号。
   * 建号的哈希计算刻意放在事务之外 —— bcrypt 要 ~300ms,不该占着数据库连接。
   */
  private async ensureUserByEmail(
    email: string,
    input: AddSpaceMemberInput,
  ): Promise<{ id: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing !== null) return existing;

    const name = input.name?.trim();
    if (name === undefined || name === '' || input.password === undefined) {
      throw AppError.validation('该邮箱尚未注册,建号需要同时提供姓名与初始密码');
    }

    const passwordHash = await this.passwords.hash(input.password);

    return this.prisma.user
      .create({ data: { email, name, passwordHash }, select: { id: true } })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw AppError.validation('该邮箱刚刚已被注册,请重试');
        }
        throw error;
      });
  }

  /** 由名称转写 slug 并保证唯一。连续 50 个都被占用时拼随机后缀兜底。 */
  private async deriveUniqueSlug(name: string): Promise<string> {
    const base = slugBaseOf(name);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.space.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (taken === null) return candidate;
    }

    return `${base}-${randomBytes(4).toString('hex')}`;
  }
}

// ==================================================================
// 模块级纯函数(便于单测,且不依赖 this)
// ==================================================================

/** 最后一个管理员不许被动。由调用方在 Serializable 事务内调用。 */
async function assertNotLastAdmin(tx: Prisma.TransactionClient, spaceId: string): Promise<void> {
  const admins = await tx.spaceMember.count({ where: { spaceId, role: 'admin' } });
  if (admins <= 1) {
    throw AppError.validation('不能移除或降级空间里最后一个管理员');
  }
}

/**
 * 取名称首字作为标识字。用 `Array.from` 而不是 `name[0]`,
 * 否则会把 emoji / 代理对切成半个字符,渲染出乱码方块。
 */
function firstLetter(name: string): string {
  const [first] = Array.from(name.trim());
  return first ?? '空';
}

/**
 * 由名称转写 slug 的「基」:只保留 ASCII 字母数字,其余折成连字符。
 *
 * 中文名会整体折没,回落成 'space'。这是有意的 —— 阶段一的路由用的是
 * spaceId(uuid,§7.2),slug 只是给人和日志看的,不值得为它引入拼音库。
 */
function slugBaseOf(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 截到 39,给 '-<两位序号>' 或 '-<8位随机>' 留出空间,总长不超 48。
  return ascii.length >= 2 ? ascii.slice(0, 39) : 'space';
}

function toSpaceSummary(row: SpaceRow): Omit<SpaceSummary, 'role' | 'memberCount'> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    letter: row.letter,
    color: row.color,
  };
}

/** 角色值非法时返回 null,由调用方跳过或报 notFound —— 绝不兜底授予角色。 */
function toMemberViewOrNull(row: MemberRow, ownerId: string): SpaceMemberView | null {
  const role = toSpaceRole(row.role);
  if (role === null) return null;

  return {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    department: row.user.department,
    avatarColor: row.user.avatarColor,
    role,
    isOwner: row.user.id === ownerId,
    joinedAt: row.createdAt.toISOString(),
  };
}

/** 排序:所有者第一 → 角色从高到低 → 加入时间从早到晚。 */
function compareMemberViews(a: SpaceMemberView, b: SpaceMemberView, ownerId: string): number {
  const aOwner = a.userId === ownerId;
  const bOwner = b.userId === ownerId;
  if (aOwner !== bOwner) return aOwner ? -1 : 1;

  const rankDiff = ROLE_RANK[b.role] - ROLE_RANK[a.role];
  if (rankDiff !== 0) return rankDiff;

  return a.joinedAt.localeCompare(b.joinedAt);
}
