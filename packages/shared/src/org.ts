/**
 * 组织架构与人员 —— DESIGN.md §4 / §6.2 / §8.5。
 *
 * v2.0 起人员是**预置**的(不是注册来的),且自带组织归属。
 * 一个人可以同属多个部门 / 组 / 项目 —— 由 `org_assignments` 承载(多对多)。
 */

export const USER_STATUSES = ['active', 'disabled', 'departed'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * 状态的中文标签。
 * ⚠️ 「离职」(`departed`)与「停用」(`disabled`)是两回事:
 * 离职是人事状态(人不在公司了),停用是账号状态(还在公司但账号被封)。
 * 不要合并它们 —— 前端在作者名旁显示的「已离职」只对前者成立。
 */
export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = Object.freeze({
  active: '在职',
  disabled: '已停用',
  departed: '已离职',
});

/**
 * 新账号的初始密码 —— **内置常量,不进 Excel 模板**(DESIGN §6.1.2)。
 *
 * ⚠️ 全员相同,所以建号时 `must_change_password` 必须为 `true`,
 * 且首次登录的拦截必须落在**服务端**(全局守卫),不能只做前端跳转 ——
 * 用户手工敲别的 URL 就绕过去了。
 */
export const INITIAL_PASSWORD = '123456';

/** 密码强度要求:至少 8 位,且必须同时含字母与数字。 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * 校验密码强度 —— **只在改密接口调用,登录时不调用**。
 *
 * 登录时不校验是刻意的:否则一旦收紧规则,**老账号会直接登不上**。
 * 返回 `null` 表示通过,否则返回可直接展示给用户的中文原因。
 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `密码至少 ${String(PASSWORD_MIN_LENGTH)} 位`;
  }
  if (!/[A-Za-z]/.test(password)) return '密码必须同时包含字母与数字(缺字母)';
  if (!/[0-9]/.test(password)) return '密码必须同时包含字母与数字(缺数字)';
  return null;
}

export interface OrgUserView {
  id: string;
  employeeNo: string;
  name: string;
  status: UserStatus;
  isSuperAdmin: boolean;
  /** 组织归属的节点路径,如 `["技术部 / 后端组"]`。一人可有多条 */
  scopePaths: string[];
  lastLoginAt: string | null;
}

export interface CreateUserInput {
  employeeNo: string;
  name: string;
  /** 可选:建号时一并指定归属节点 */
  nodeIds?: string[];
}

export interface UpdateUserInput {
  name?: string;
  status?: UserStatus;
}

export interface SetUserAssignmentsInput {
  nodeIds: string[];
}

/** 组织范围的展示形态:一个节点的路径 + 该范围内的人数。 */
export interface OrgScopeOption {
  nodeId: string;
  path: string;
  memberCount: number;
}

// ---------------- Excel 导入(§8.5) ----------------

/**
 * 差异预览。`dryRun` 返回它,**不写库**。
 *
 * ⚠️ 它与真正写入**共用同一份解析逻辑**(同一个接口的两个模式),
 * 否则两边迟早算出不同结果,而管理员是照着预览做决定的。
 */
export interface OrgImportPreview {
  newUsers: { employeeNo: string; name: string; nodePaths: string[] }[];
  renamedUsers: { employeeNo: string; from: string; to: string }[];
  newAssignments: { employeeNo: string; nodePath: string }[];
  /** 表格里出现但系统里没有的节点 */
  newNodes: { path: string }[];
  ownerChanges: { nodePath: string; fromName: string | null; toName: string }[];
  /** 被跳过的行(如整行空白) */
  ignoredRows: { row: number; reason: string }[];
  /**
   * 校验错误。**非空时不允许写入** —— 前端必须把它显式显示出来,
   * 而不是"忽略有问题的行然后照样导"。
   */
  errors: { row: number; reason: string }[];
}

export interface OrgImportResult {
  createdUsers: number;
  createdNodes: number;
  createdAssignments: number;
  updatedNames: number;
  updatedOwners: number;
}

/**
 * 导入模板的查询参数。
 * `rootNodeId` 是给"只导某个部门"留的口子 —— 一期只导全量,所以现在不用。
 */
export interface ImportTemplateQuery {
  rootNodeId?: string;
}
