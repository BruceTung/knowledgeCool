/**
 * 审计日志的共享类型 —— 对应 DESIGN.md §6.2 的 `GET /audit-logs`。
 *
 * 审计日志是**只写不删**的:阶段一不提供任何删除接口,
 * 保留策略(按天分区 / 定期归档)留到规模上来再说。
 */

/** 会被记录的动作。刻意用字符串常量而不是枚举 —— 日志的取值应该能自由扩展。 */
export const AUDIT_ACTIONS = [
  'auth.setup',
  'auth.login',
  'auth.logout',
  'space.create',
  'space.member.add',
  'space.member.update',
  'space.member.remove',
  'page.create',
  'page.update',
  'page.move',
  'page.delete',
  'page.restore',
  'page.purge',
  'page.content.update',
  'perm.update',
  'comment.create',
  'comment.update',
  'comment.delete',
  'superadmin.bypass',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 动作的中文标签。放在 shared 是因为前端审计页要用,后端导出也可能用。 */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'auth.setup': '初始化管理员',
  'auth.login': '登录',
  'auth.logout': '登出',
  'space.create': '创建空间',
  'space.member.add': '添加成员',
  'space.member.update': '修改成员角色',
  'space.member.remove': '移除成员',
  'page.create': '新建页面',
  'page.update': '修改页面',
  'page.move': '移动页面',
  'page.delete': '删除页面(进回收站)',
  'page.restore': '恢复页面',
  'page.purge': '彻底删除页面',
  'page.content.update': '保存正文',
  'perm.update': '修改页面权限',
  'comment.create': '发表评论',
  'comment.update': '修改评论',
  'comment.delete': '删除评论',
  'superadmin.bypass': '超管绕过权限',
});

/** 一条审计记录。 */
export interface AuditLogView {
  /** BigInt 主键,序列化成字符串 —— JSON 装不下 64 位整数。 */
  id: string;
  actor: { id: string; name: string } | null;
  action: string;
  targetType: string;
  targetId: string;
  /** 目标的可读名(页面标题 / 空间名),查得到才有。 */
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
