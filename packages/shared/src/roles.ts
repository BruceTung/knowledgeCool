/**
 * 角色定义与权限矩阵 —— 对应 DESIGN.md §5.4。
 *
 * 这里刻意把「权限矩阵」写成**数据**(capability → 最低角色),而不是散落在
 * 各个 controller 里的 if 判断。原因见 DESIGN.md §12:权限判定是"错了不会立刻报错"
 * 的三类高危逻辑之一,必须能被测试整体覆盖。
 *
 * 三套角色枚举的来源(必须与 DESIGN.md §4.2 的 check 约束逐字一致):
 *   - space_members.role      ∈ admin | editor | commenter | viewer
 *   - page_permissions.role   ∈ editor | commenter | viewer | none   (不含 admin)
 *   - 判定结果 effectiveRole  ∈ admin | editor | commenter | viewer | none
 */

/** 空间成员角色。是权限判定的兜底层:页面链上没有显式规则时回退到这里。 */
export const SPACE_ROLES = ['admin', 'editor', 'commenter', 'viewer'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/**
 * 页面级显式规则可以取的角色。
 * 注意:**页面级没有 admin** —— 空间管理层级不通过页面规则授予;
 * 但可以显式写 `none`(配合 deny 或关闭继承后表达"这一篇不给权限")。
 */
export const PAGE_RULE_ROLES = ['editor', 'commenter', 'viewer', 'none'] as const;
export type PageRuleRole = (typeof PAGE_RULE_ROLES)[number];

/** 判定结果。比 SpaceRole 多一个 `none`(无任何权限)。 */
export const EFFECTIVE_ROLES = ['admin', 'editor', 'commenter', 'viewer', 'none'] as const;
export type EffectiveRole = (typeof EFFECTIVE_ROLES)[number];

/** 角色强弱排序。数值越大权限越高,`none` 为 0。 */
export const ROLE_RANK: Readonly<Record<EffectiveRole, number>> = Object.freeze({
  none: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
});

/**
 * 所有可判定的动作。命名规则:`<资源>.<动作>`,与 DESIGN.md §6.2 的接口清单一一对应。
 */
export const CAPABILITIES = [
  'page.view',
  'comment.create',
  'comment.resolve.own',
  'comment.resolve.any',
  'page.create',
  'page.edit',
  'page.delete',
  'page.restore',
  'page.purge',
  'page.permission.update',
  'space.member.manage',
  'audit.view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * 权限矩阵本体(唯一事实来源)。逐格对应 DESIGN.md §5.4。
 *
 * 「标记评论已解决」在文档里分两格:评论者只能解决*自己的*。这里拆成两个能力:
 * `comment.resolve.own`(评论者起)与 `comment.resolve.any`(编辑者起)。
 * 所有权比较不在本表范围 —— 调用方需自行比对 comment.userId === ctx.userId。
 */
export const CAPABILITY_MIN_ROLE: Readonly<Record<Capability, EffectiveRole>> = Object.freeze({
  'page.view': 'viewer',
  'comment.create': 'commenter',
  'comment.resolve.own': 'commenter',
  'comment.resolve.any': 'editor',
  'page.create': 'editor',
  'page.edit': 'editor',
  /** 软删除 —— 可恢复,所以 editor 就够 */
  'page.delete': 'editor',
  'page.restore': 'editor',
  /** ⚠️ 唯一**不可逆**的能力(§6.2 要求 admin)。调用点看到它就该多想一秒。 */
  'page.purge': 'admin',
  'page.permission.update': 'admin',
  'space.member.manage': 'admin',
  'audit.view': 'admin',
});

/** 角色 a 是否达到角色 b 的强度。`atLeast('admin','editor') === true`。 */
export function atLeast(role: EffectiveRole, required: EffectiveRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** 判定某角色能否执行某动作。这是服务端拦截的唯一入口。 */
export function can(role: EffectiveRole, capability: Capability): boolean {
  return atLeast(role, CAPABILITY_MIN_ROLE[capability]);
}

/** 运行时校验:把数据库里读出的字符串收敛成合法角色,未知值一律视为无权。 */
export function toEffectiveRole(value: string | null | undefined): EffectiveRole {
  return isEffectiveRole(value) ? value : 'none';
}

/**
 * 运行时校验:把库里的字符串收敛成合法**空间**角色;未知值返回 `null`。
 *
 * 与 `toEffectiveRole` 的差别很关键:后者兜底成 `none`(偏「不给」),
 * 而空间角色没有 `none` 这个取值。所以这里**不兜底**,返回 `null`
 * 让调用方自己决定(跳过该行 / 报 notFound),而不是猜一个角色授予出去。
 */
export function toSpaceRole(value: string | null | undefined): SpaceRole | null {
  return isSpaceRole(value) ? value : null;
}

export function isEffectiveRole(value: unknown): value is EffectiveRole {
  return typeof value === 'string' && (EFFECTIVE_ROLES as readonly string[]).includes(value);
}

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && (SPACE_ROLES as readonly string[]).includes(value);
}

export function isPageRuleRole(value: unknown): value is PageRuleRole {
  return typeof value === 'string' && (PAGE_RULE_ROLES as readonly string[]).includes(value);
}
