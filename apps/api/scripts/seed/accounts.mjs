/**
 * 种子账号的**结构**定义 —— 只有账号、角色、组织归属,**没有密码**。
 *
 * ## 为什么不把密码写在这里(以及任何地方)
 *
 * 这份文件会进版本控制。只要密码以明文形式躺在仓库里,下面三件事就都成立:
 *
 *   1. 任何拿到仓库的人 —— 包括 CI 日志、克隆过它的人、备份出去的目录 ——
 *      都拿到了**能直接登录生产**的口令;
 *   2. 删掉文件也删不掉历史(`git log` 里还在),所以"后来改了"不算数;
 *   3. 更糟的是它会显得很合理:「测试账号的密码嘛,不算什么」,
 *      于是同样的做法迟早被用到真实账号上。
 *
 * → 所以**这里一个密码都没有**。密码有两个来源,都由执行的人在运行时提供:
 *   ① 交互式输入(推荐,见 `admin-init.mjs`);
 *   ② 环境变量 `KC_INIT_PASSWORD`(给自动化用,例如首次部署的 compose 流程)。
 *
 * 两者都**只存在于进程内存**,不落盘、不进日志、不进审计。
 *
 * ## 为什么种子数据本身是可以进仓库的
 *
 * 工号、姓名、角色、组织归属**不是机密** —— 它们本来就是界面上的可见信息,
 * 而且种子必须可复现才能当验收基线。真正要守的只有「谁能用这个账号进来」。
 *
 * ## 角色怎么表达
 *
 * ⚠️ 这里**没有"角色"字段**,只有 `isSuperAdmin` 与「谁拥有哪些节点」——
 * 因为 v2 的权限模型里**不存在角色表**(§5.3:权限只有所有者 / 祖先链 / 显式授权
 * 三个概念)。"部长"不是一个角色,而是"他是一级部门的所有者"这件事实。
 * → 所以 `owns` 写的是**节点标题**,脚本会按标题找到 id 并设置所有权。
 * 这也正是它必须走真实 Excel 导入或按标题匹配的原因,而不是直接插 id。
 */

/*
 * 一个种子账号的形状(这里是 JSDoc 而不是 `interface` ——
 * ⚠️ 这是 .mjs,纯 JavaScript:`export interface` 是 TypeScript 语法,
 * Node 会在**加载时**直接抛 SyntaxError。而这个文件要被 admin-init.mjs
 * import,所以它必须能被 Node 原生加载,不能有任何 TS 语法。
 *
 * `passwordMode` 决定这个账号初始时是否被要求改密:
 *   · `initial` —— 用**统一的初始密码**登录,登录后必须改密(§6.1.2)。
 *     用来验「新员工入职」这条路径。
 *   · `fixed`  —— 登录后**不**改密,直接进系统。
 *     用来给那些「必须在种子里创建内容」的账号 ——
 *     未改密的人**没有任何登录态**,所有业务接口都会回 401(§6.1.2)。
 *
 * @typedef {object} SeedAccount
 * @property {string} employeeNo
 * @property {string} name
 * @property {'initial'|'fixed'} passwordMode  初始密码的来源,两种都**不**在本文件里出现明文
 * @property {boolean} [isSuperAdmin]
 * @property {readonly string[]} [owns]        他拥有所有权的节点标题(按标题匹配,不是 id)
 * @property {readonly string[]} [assignedTo]  他归属的组织节点标题 —— 决定他能建什么、能管什么(§5.3 规则三)
 * @property {string} [avatarColor]
 * @property {'active'|'disabled'|'departed'} [status]
 */

/**
 * 演示 / 验收用的最小组织架构。
 *
 * ⚠️ 刻意**只有三个一级部门**,而不是完整公司 —— 它要回答的问题是
 * "组织树的每一种形状都出现过了吗",而二级节点(组/项目)、
 * 普通页面、受限节点这几种形态在种子里都有了。
 * 堆更多部门不会让覆盖率提高,只会让种子更难读。
 */
export const SEED_DEPARTMENTS = [
  { title: '技术部', ownerEmployeeNo: 'KC002' },
  { title: '市场部', ownerEmployeeNo: 'KC005' },
];

/**
 * 二级节点(组 / 项目)。挂在 `parentTitle` 下面。
 *
 * ⚠️ **故意造一个"无负责人"的组**(`ownerEmployeeNo: null`):
 * `requireCreateUnder` 允许部门负责人代管他没指定负责人的组(§5.3),
 * 而这条分支只有种子里有一个这样的组才会被验到。
 */
export const SEED_SUB_NODES = [
  { title: '后端组', parentTitle: '技术部', ownerEmployeeNo: 'KC003' },
  { title: 'CRM 项目', parentTitle: '技术部', ownerEmployeeNo: 'KC003' },
  // 部门负责人代管 —— 见上面那条注释
  { title: '市场部工作方式', parentTitle: '市场部', ownerEmployeeNo: null },
];

/**
 * 演示文档。**正文是空树**,只有标题 —— 文档内容在种子里不重要,
 * 而真写一段正文就要引入编辑器那套依赖,收益为零。
 */
export const SEED_DOCUMENTS = [
  { title: '研发规范', parentTitle: '技术部', ownerEmployeeNo: 'KC002' },
  { title: '技术方案', parentTitle: '技术部', ownerEmployeeNo: 'KC002' },
];

/**
 * 种子账号清单。
 *
 * ⚠️ **为什么这 5 个账号的组合是有意的**(不是随便凑的):
 *
 *   | 工号 | 覆盖的场景                                        |
 *   |------|---------------------------------------------------|
 *   | KC001 | 唯一的超管;不归属任何节点 —— 证明超管的组织范围为空 |
 *   | KC002 | 一级部门所有者(部长)→ 验「祖先链所有者」这一档权限 |
 *   | KC003 | 二级节点所有者(组长)+ **多归属** → 验横向范围约束   |
 *   | KC004 | 纯组员、待首登改密 → 验「首登不建会话」整条链路   |
 *   | KC005 | 另一个部门的部长 → 验「部长管不到别的部门」         |
 *
 * 少任何一个都会留下一条判定路径没被验过 —— 种子不是"演示用",它是**验收基线**。
 */
export const SEED_ACCOUNTS = [
  {
    employeeNo: 'KC001',
    name: '知源管理员',
    passwordMode: 'fixed',
    isSuperAdmin: true,
    // 刻意不给 assignedTo:超管不该有组织归属,§5.3 明确讨论过这一点
    owns: [],
    avatarColor: 'blue',
  },
  {
    employeeNo: 'KC002',
    name: '技术部部长',
    passwordMode: 'fixed',
    owns: ['技术部', '研发规范', '技术方案'],
    assignedTo: ['技术部'],
    avatarColor: 'green',
  },
  {
    employeeNo: 'KC003',
    name: '后端组组长',
    passwordMode: 'fixed',
    // 多归属:同时在「后端组」与「CRM 项目」下 ——
    // 验「一个人在多个组里,组织范围是它们的并集」
    owns: ['后端组', 'CRM 项目'],
    assignedTo: ['后端组', 'CRM 项目'],
    avatarColor: 'purple',
  },
  {
    employeeNo: 'KC004',
    name: '技术部组员',
    passwordMode: 'initial',
    // 不 owns 任何东西 → 他改不了任何节点,只能新建
    assignedTo: ['后端组'],
    avatarColor: 'amber',
  },
  {
    employeeNo: 'KC005',
    name: '市场部部长',
    passwordMode: 'fixed',
    owns: ['市场部', '市场部工作方式'],
    assignedTo: ['市场部'],
    avatarColor: 'rose',
  },
];

/*
 * 已存在的账号怎么处理 —— **默认不动**。
 *
 * ⚠️ 这条默认值是整份清单里最重要的一个决定。
 * 种子脚本最危险的动作是「把一个正在用的账号改回演示状态」:
 * 生产里 KC002 早就是某个真的部长了,脚本一跑就把他的密码重置了、
 * 组织归属清空了 —— 而脚本自己报告「成功」。
 *
 * → 所以默认 `skip`:只**报告**差异,不改任何东西。
 * 真的要覆盖必须显式传 `--overwrite-users`,那是一个应该让人犹豫的开关。
 *
 * @typedef {'skip'|'updateOrgOnly'|'overwrite'} OnExisting
 */

/** @type {OnExisting} */
export const DEFAULT_ON_EXISTING = 'skip';
