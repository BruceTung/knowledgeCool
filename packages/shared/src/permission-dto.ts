/**
 * 页面权限的共享类型 —— 对应 DESIGN.md §5 与 §6.2 的权限接口。
 *
 * 三条来自 §5.3 的语义,在类型注释里再钉一遍(实现时最容易弄错的就是这些):
 *   1. **只存显式规则,不存最终结果** —— 运行时沿物化路径向上回溯判定。
 *   2. **拒绝优先** —— 任一命中规则 `deny=true` 即短路,不受层级影响。
 *   3. **就近覆盖** —— 同层多规则命中时 user 强于 group;更深(更靠近自身)的层覆盖更浅的。
 */

import type { EffectiveRole, PageRuleRole, SpaceRole } from './roles.js';
// SubjectType 的**唯一定义**在 permission.ts(判定用),这里只借用 ——
// 两处各定义一个同名类型会让 index.ts 的 `export *` 撞成 TS2308。
import type { SubjectType } from './permission.js';

/** 权限主体类型。阶段一没有独立用户组表,**group 的 subjectId 就是部门名**。 */
export const SUBJECT_TYPES = ['user', 'group'] as const satisfies readonly SubjectType[];

export function isSubjectType(value: unknown): value is SubjectType {
  return typeof value === 'string' && (SUBJECT_TYPES as readonly string[]).includes(value);
}

/** 一条显式规则的展示形态。 */
export interface PageRuleView {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  /** 服务端解析出的可读名(用户姓名或部门名);解析不到时为空。 */
  subjectLabel: string | null;
  role: PageRuleRole;
  deny: boolean;
}

/**
 * 推导链上的一环。
 *
 * 这是 UI 里「有效权限推导链」那个组件的数据源 ——
 * 让管理员看得见"这个角色到底是从哪一层来的",而不是只看到一个结果。
 */
export interface ChainStep {
  pageId: string;
  pageTitle: string;
  depth: number;
  /** 该层解析出的角色;`null` 表示这一层没有任何命中规则(继承给上层)。 */
  role: EffectiveRole | null;
  /** 这一层的角色是从哪来的。 */
  source: 'rule' | 'deny' | 'none';
}

/** `GET /pages/:id/permissions` 的响应体。 */
export interface PagePermissionsResponse {
  pageId: string;
  pageTitle: string;
  /** 我在这篇页面上的有效角色。 */
  myRole: EffectiveRole;
  /** 我的空间角色。不是空间成员时为 null。 */
  spaceRole: SpaceRole | null;
  /** 本页的显式规则(不含祖先的)。 */
  rules: PageRuleView[];
  /** 从根到自身逐层推导出的角色链。 */
  chain: ChainStep[];
}

/**
 * `PUT /pages/:id/permissions` 的请求体 —— **整表替换**,不是增量。
 *
 * 整表替换的理由:规则集合很小(通常个位数),而增量的"删一条改一条"
 * 需要客户端维护 diff,一旦不一致就会出现"界面上删了、库里还在"的幽灵规则。
 */
export interface SavePagePermissionsInput {
  rules: Array<{
    subjectType: SubjectType;
    subjectId: string;
    role: PageRuleRole;
    deny: boolean;
  }>;
}

/** 可被授权的候选主体(用于权限弹窗的自动补全)。 */
export interface PermissionSubjectCandidate {
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  /** 部门候选会附带成员数;用户候选为 null。 */
  memberCount: number | null;
}

/** 单条规则的字符上限,防止把整段 SQL 塞进 subjectId。 */
export const PERMISSION_SUBJECT_MAX_LENGTH = 120;

/** 单页规则条数上限。超过这个数说明该用用户组而不是逐条授。 */
export const PERMISSION_RULE_MAX_COUNT = 200;
