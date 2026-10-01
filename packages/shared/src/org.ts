/**
 * 组织架构与人员 —— DESIGN.md §4 / §6.2 / §8.4。
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
  /**
   * 归属节点的 id,与 `scopePaths` **同序**。
   *
   * 为什么两个都要给:路径是给人看的,id 是给「设置归属」那个多选框用的。
   * 只给路径的话,前端要靠文本匹配才能把已选项勾上 —— 而一旦某条归属
   * 不在候选列表里(例如它挂在三级节点上),那一条会在保存时被**静默丢掉**,
   * 因为保存是整表替换。
   */
  scopeNodeIds: string[];
  /**
   * 密码还是**初始值**(或刚被超管重置过),首次登录尚未完成。
   *
   * 为什么把它放进人员列表:这是「谁还能用 123456 登进去」这个问题的**唯一答案**。
   * 系统里全员初始密码相同(§6.1.2),所以"还有多少人没改"直接等于
   * "还有多少个账号谁都能登" —— 这属于管理员必须一眼看见的信息,
   * 不该藏在数据库里等人去查。
   */
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

/**
 * 一页人员。
 *
 * ⚠️ 这个包装类型是**为了修一个静默截断**而加的:此前接口直接返回数组,
 * 服务端 `take: 200` 一截了事 —— 全公司有 320 人时,管理员只看到 200 个,
 * 而**界面上没有任何迹象**。表现是「某某人的账号不见了」,
 * 而他会去翻工号、以为自己记错了。没有 total,前端根本无从判断
 * 自己拿到的是不是全部。
 */
export interface OrgUserListResponse {
  users: OrgUserView[];
  /** 符合条件的总人数(**不受本页 limit 影响**) */
  total: number;
  /** 下一页的游标(工号)。null = 已经是最后一页 */
  nextCursor: string | null;
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

// ---------------- 节点成员管理(v2.4) ----------------

/**
 * 一个节点的成员视图。
 *
 * ⚠️ 这里说的「成员」是**组织归属**(`org_assignments`),不是权限。
 * 归属是组织事实(他在哪个部门 / 组),权限是判定结果(他能改什么)——
 * 两者刻意不混在一个界面里,所以成员弹窗与权限弹窗是两个入口。
 *
 * 之所以需要这个视图:增量导入无法表达「调岗」(§8.4 已知限制),
 * 而在这之前要"把某人移出某个组"只能到「人员管理 → 设置归属」整表替换,
 * 看不到"这个节点下都有谁"。
 */
export interface NodeMemberView {
  userId: string;
  name: string;
  employeeNo: string;
  status: UserStatus;
  /** 这个人在**这个节点子树内**的归属节点 id(通常只有一条) */
  memberNodeIds: string[];
  /** 他在这个子树内的归属路径,如 `技术部 / 后端组` */
  memberPaths: string[];
  /**
   * 他在**别处**还有的归属(子树之外),如 `市场部 / CRM 项目`。
   *
   * 必须显示出来:移出这里的一条归属**不会**让他失去全部归属,
   * 界面上不写清楚的话,管理员会以为把他"踢出公司"了。
   */
  otherPaths: string[];
  /**
   * 他就是这个节点的所有者(组长 / 部长)。
   *
   * ⚠️ **移出归属不改变所有权** —— 这是刻意的(归属与所有权是两件事),
   * 但界面上必须提示,否则管理员会以为"移出组长"就换掉了组长。
   */
  isOwnerHere: boolean;
  /**
   * 他是祖先链上的所有者 —— 也就是"他本来就能管这个节点"。
   * 这类人通常**不该**被移出(他是部长),界面给出更强的提示。
   */
  isAncestorOwner: boolean;
}

/** `GET /nodes/:nodeId/members` 的响应。 */
export interface NodeMembersResponse {
  nodeId: string;
  title: string;
  /**
   * 直接归属在这个节点上的人 —— **只有这些人能从这里移出**。
   * 子孙节点上的人要移出,得到对应的子孙节点上去操作。
   */
  direct: NodeMemberView[];
  /** 归属在子孙节点上的人(含上面那批人的路径)。只读展示,用于回答"这个部门下都有谁" */
  inherited: NodeMemberView[];
  /** 我能否增删这里的归属 —— 前端据此隐藏按钮,服务端仍是唯一裁判 */
  canManage: boolean;
}

/** 把某人加入某节点(追加一条归属,**不是整表替换**)。 */
export interface AddNodeMemberInput {
  userId: string;
}

// ---------------- Excel 导入(§8.4) ----------------

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
  /**
   * 节点改名的差异。
   *
   * 之所以需要它:用户明确"部门只会更名不会消失",所以模板里有只读的
   * `部门ID(勿改)` 列 —— 名称对不上但 ID 对得上时,识别成**改名**而不是新建。
   * 这一项就是把它显示给管理员确认。
   */
  renamedNodes: { nodePath: string; from: string; to: string }[];
  ownerChanges: { nodePath: string; fromName: string | null; toName: string }[];
  /** 被跳过的行(如重复行) */
  ignoredRows: { row: number; reason: string }[];
  /**
   * 校验错误。**非空时不允许写入** —— 前端必须把它显式显示出来,
   * 而不是"忽略有问题的行然后照样导"。
   *
   * `row` 为 `0` 表示问题不在某一行上,而是跨行的整体校验(如"某部门没有负责人")。
   */
  errors: { row: number; reason: string }[];
}

/**
 * 上传解析后的返回体。
 *
 * `contentHash` 用来保证「预览的那份文件」与「确认写入的那份文件」是同一份:
 * 确认时带上它,不一致则 409。没有这个校验的话,管理员在预览之后
 * 又改了一版表格再上传,写入的就是他没看过的那一份 —— 而他会以为看过。
 */
export interface OrgImportResponse {
  contentHash: string;
  preview: OrgImportPreview;
  /** 预览模式下为 `null`;确认写入后是实际写入的条数 */
  applied: OrgImportResult | null;
}

/** 模板下载的查询参数 —— 默认全量。 */
export interface ImportTemplateQuery {
  /** 只导出某个部门下的人与结构(留的口子,界面暂未用) */
  rootNodeId?: string;
}

export interface OrgImportResult {
  createdUsers: number;
  createdNodes: number;
  createdAssignments: number;
  updatedNames: number;
  updatedOwners: number;
}
