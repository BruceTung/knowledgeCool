/**
 * 审计日志的共享类型 —— 对应 DESIGN.md §6.2 的 `GET /audit-logs`。
 *
 * 审计日志是**只写不删**的:阶段一不提供任何删除接口,
 * 保留策略(按天分区 / 定期归档)留到规模上来再说。
 *
 * ⚠️ v2.0 的动作名整体换了前缀:`space.*` / `page.*` → `org.*` / `node.*`,
 * `perm.update` → `grant.replace`。并且**删掉了 `superadmin.bypass`** ——
 * 新模型里没有超管旁路(§4.3),那个动作不会再出现。
 */

/** 会被记录的动作。刻意用字符串常量而不是枚举 —— 日志的取值应该能自由扩展。 */
export const AUDIT_ACTIONS = [
  // 认证
  'auth.setup',
  'auth.login',
  /**
   * 账号因连续登录失败被临时锁定(v2.12 加限流时就有,但**一直漏在这一行清单外**)。
   *
   * ⚠️ 漏登的后果不是"少一条日志",而是审计页的筛选器由本清单生成
   * (`AUDIT_ACTION_LABELS` 也在这里)—— 于是这些真实存在的锁定记录
   * 既没有中文标签、也筛不出来,看起来像是不存在的动作。
   * 任何 `recordAudit` 用到的 action 都必须在这里有位置。
   */
  'auth.login.locked',
  'auth.logout',
  'auth.password.change',
  // 节点
  'node.create',
  'node.update',
  'node.move',
  /** 批量移动(v2.14)—— 一次动多个,留痕时带上是哪几个 */
  'node.bulkMove',
  /** 删除节点 —— v2.12 起是**物理删除**,不可恢复(回收站已移除) */
  'node.delete',
  'node.content.update',
  /** 任命 / 变更所有者 —— 直接改变"谁能改什么",是最该留痕的一类 */
  'node.owner.update',
  // 授权
  'grant.replace',
  /** 可见性 / 读者名单被改动(v2.13)—— 保密相关的变更必须留痕 */
  'visibility.replace',
  // 组织架构
  'org.import',
  'org.user.create',
  'org.user.update',
  /** 超管把某人的密码打回初始值 —— 直接改变「谁能登进这个账号」,必须留痕 */
  'org.user.reset_password',
  'org.assignment.set',
  /** 在某个节点上单独加人 / 移出人(v2.4 节点成员管理入口) */
  'org.member.add',
  'org.member.remove',
  // 评论
  'comment.create',
  'comment.update',
  'comment.delete',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 动作的中文标签。放在 shared 是因为前端审计页要用,后端导出也可能用。 */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'auth.setup': '初始化管理员',
  'auth.login': '登录',
  'auth.login.locked': '登录失败锁定',
  'auth.logout': '登出',
  'auth.password.change': '修改密码',
  'node.create': '新建节点',
  'node.update': '修改节点',
  'node.move': '移动节点',
  'node.bulkMove': '批量移动节点',
  'node.delete': '删除节点',
  'node.content.update': '保存正文',
  'node.owner.update': '变更所有者',
  'grant.replace': '调整授权名单',
  'visibility.replace': '修改可见范围',
  'org.import': '导入组织架构',
  'org.user.create': '新建人员',
  'org.user.update': '修改人员',
  'org.user.reset_password': '重置密码',
  'org.assignment.set': '调整组织归属',
  'org.member.add': '节点添加成员',
  'org.member.remove': '节点移出成员',
  'comment.create': '发表评论',
  'comment.update': '修改评论',
  'comment.delete': '删除评论',
});

/** 一条审计记录。 */
export interface AuditLogView {
  /** BigInt 主键,序列化成字符串 —— JSON 装不下 64 位整数。 */
  id: string;
  actor: { id: string; name: string } | null;
  action: string;
  targetType: string;
  targetId: string;
  /** 目标的可读名(节点标题 / 人名),查得到才有。 */
  targetLabel: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** `GET /audit-logs` 的响应体。游标分页:用最后一条的 id 作为下一页的 cursor。 */
export interface AuditLogPage {
  items: AuditLogView[];
  /** 下一页游标;为 null 表示到底了。 */
  nextCursor: string | null;
}

export const AUDIT_PAGE_SIZE = 50;

/**
 * 导出上限(v2.14)。
 *
 * ⚠️ 这个上限不是「性能优化」,而是**防止一次导出把服务打挂**:
 * 审计表只增不减,不加限制就是一次全表扫描加一个几百 MB 的响应。
 * 超了要**明确告诉用户**只导出了最近多少条 —— 审计数据的静默截断
 * 比没有导出更糟(他会以为这就是全部)。
 */
export const AUDIT_EXPORT_MAX_ROWS = 5000;
