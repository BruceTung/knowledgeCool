/**
 * 空间与成员相关的共享类型 —— 对应 DESIGN.md §6.2 的空间接口。
 *
 * 放这里而不是各写一份:前端成员管理页的角色下拉、后端 DTO 的校验白名单,
 * 都取自同一份枚举(roles.ts 的 SPACE_ROLES),不可能漂移。
 */
import type { SpaceRole } from './roles.js';

/**
 * 头像/空间标识可选的颜色。
 *
 * 刻意收成固定白名单而不是「任意字符串」:这个值最终会进前端的样式类名,
 * 自由字符串等于开了个注入口子。服务端用 `@IsIn(AVATAR_COLORS)` 校验。
 */
export const AVATAR_COLORS = ['blue', 'teal', 'amber', 'purple', 'pink', 'gray'] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** 空间列表项。比 `VisibleSpace` 多一个成员数 —— 列表页要显示它。 */
export interface SpaceSummary {
  id: string;
  name: string;
  slug: string;
  letter: string;
  color: string;
  /** 我在这个空间里的角色。 */
  role: SpaceRole;
  memberCount: number;
}

/**
 * 新建空间请求体。
 *
 * `slug` / `letter` / `color` 都可省:服务端按名称推导(letter 取首字、
 * slug 由名称转写并保证唯一、color 默认 blue),前端不必逼用户填这些。
 */
export interface CreateSpaceInput {
  name: string;
  slug?: string;
  letter?: string;
  color?: AvatarColor;
}

/** 空间成员视图(成员管理页用)。**不含**任何密码相关字段。 */
export interface SpaceMemberView {
  userId: string;
  email: string;
  name: string;
  department: string | null;
  avatarColor: string;
  role: SpaceRole;
  /**
   * 是否空间所有者(§5.1 的组织级 Owner)。
   * 所有者不可被移除、也不可被降级 —— 否则空间会失去归属,
   * 而「转移所有权」阶段一没做。
   */
  isOwner: boolean;
  joinedAt: string;
}

/** `GET /spaces/:id/members` 的响应体。带上 space 让成员页能直接渲染,不必等空间列表加载。 */
export interface SpaceMembersResponse {
  space: SpaceSummary;
  members: SpaceMemberView[];
}

/**
 * 邀请 / 创建成员。
 *
 * 两种情形合并成一个接口(因为管理员的意图都是「让这个人进空间」):
 *  - 邮箱已存在 → 直接加入空间,忽略 `name` / `password`;
 *  - 邮箱不存在 → 用 `name` + `password` 建号,再加入空间。
 */
export interface AddSpaceMemberInput {
  email: string;
  role: SpaceRole;
  /** 仅当邮箱不存在、需要建号时必填。 */
  name?: string;
  /** 仅当邮箱不存在、需要建号时必填。 */
  password?: string;
  /**
   * 部门。
   *
   * 阶段一的「用户组」就取这个字段(`users.department`),所以它是
   * **组级权限规则能生效的前提** —— 没有地方能设置它的话,
   * 「给一个部门授权」这个能力在界面上就是死的。
   * 邮箱已存在时也会用它覆盖既有值(管理员在邀请时顺手校正部门是很自然的动作)。
   */
  department?: string;
}

/** 修改成员角色。 */
export interface UpdateSpaceMemberRoleInput {
  role: SpaceRole;
}
