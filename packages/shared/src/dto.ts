/**
 * 通用 DTO 类型 —— 前后端共享。
 * 阶段一只放真正通用的部分;各模块的 DTO 在 M2~M5 随接口一起加。
 */

export interface CursorQuery {
  /** 游标分页:上一页返回的 nextCursor。不传表示从最新开始。 */
  cursor?: string;
  /** 默认 20,上限 100(由服务端 clamp)。 */
  limit?: number;
}

/** 游标分页响应。评论与审计日志用它(见 DESIGN.md §6.1)。 */
export interface CursorPage<T> {
  items: T[];
  /** 为 null 表示没有下一页。 */
  nextCursor: string | null;
}

/** 健康检查响应。 */
export interface HealthResponse {
  status: 'ok';
  /** 进程已运行秒数。 */
  uptime: number;
  version: string;
}

export type ComponentStatus = 'up' | 'down';

export interface ReadinessResponse {
  status: 'ok' | 'degraded';
  components: Record<string, { status: ComponentStatus; error?: string }>;
}
