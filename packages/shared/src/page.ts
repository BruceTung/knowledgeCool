/**
 * 页面树相关的共享类型 —— 对应 DESIGN.md §6.2 的页面接口。
 *
 * 树是**一次性整棵返回**的,不做懒加载:知识库的页面树规模在几百到几千,
 * 一次取回换来的是前端的展开/拖拽全部变成纯本地计算,不必为每个节点发请求。
 * 代价是响应体较大,所以节点字段刻意保持精简(不含正文)。
 */
import type { SpaceRole } from './roles.js';

/** 页面状态。取值与 migration 里的 CHECK 约束逐字一致。 */
export const PAGE_STATUSES = ['draft', 'published', 'archived'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export function isPageStatus(value: unknown): value is PageStatus {
  return typeof value === 'string' && (PAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * 页面树节点。
 *
 * 不暴露 `materializedPath`:它是服务端的实现细节(为「查整棵子树」服务),
 * 泄漏给客户端只会让人忍不住在前端拼路径 —— 而路径在 move 之后会变。
 */
export interface PageNode {
  id: string;
  parentId: string | null;
  title: string;
  /** 同级排序。允许有空洞(移动后会留空隙),前端只需按它升序排。 */
  position: number;
  depth: number;
  status: PageStatus;
  /** 乐观锁版本号。改名 / 移动时必须原样带回。 */
  version: number;
  children: PageNode[];
}

/** `GET /spaces/:id/pages` 的响应体。 */
export interface PageTreeResponse {
  spaceId: string;
  /** 我在这个空间里的角色 —— 前端据此决定显示哪些操作。服务端仍是唯一裁判。 */
  role: SpaceRole;
  nodes: PageNode[];
}

/** 新建页面。 */
export interface CreatePageInput {
  spaceId: string;
  /** null 表示建在空间根下。 */
  parentId: string | null;
  /** 省略时用「未命名页面」(与数据库默认值一致)。 */
  title?: string;
}

/** 改名 / 改状态。 */
export interface UpdatePageInput {
  title?: string;
  status?: PageStatus;
  /** 乐观锁。不匹配返回 409 VERSION_CONFLICT。 */
  version: number;
}

/**
 * 移动页面(拖拽排序与改父级是同一个操作)。
 *
 * 这是整个 M3 里最容易做错的一处:服务端必须**递归重建整棵子树**的
 * materialized_path 与 depth,只改自己那一条会让所有子孙的路径失效,
 * 而且当下不会报任何错。
 */
export interface MovePageInput {
  /** null 表示移到空间根下。 */
  newParentId: string | null;
  /** 在目标父节点下的插入下标(0 起)。省略表示追加到末尾。 */
  newPosition?: number;
  version: number;
}

/** 面包屑的一环。 */
export interface PageBreadcrumb {
  id: string;
  title: string;
}

/** `GET /pages/:id` 的响应体。 */
export interface PageDetail {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  status: PageStatus;
  version: number;
  depth: number;
  /** 从根到自身的祖先链(**不含自身**),用于面包屑。 */
  breadcrumb: PageBreadcrumb[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 回收站条目。
 *
 * 只列「被删子树的根」—— 子孙不单独出现,因为恢复是整棵子树一起回来的。
 */
export interface TrashItem {
  id: string;
  spaceId: string;
  title: string;
  deletedAt: string;
  deletedBy: string | null;
  /** 被一并删掉的子孙数量(不含自身)。给用户一个「删掉了多少」的直觉。 */
  descendantCount: number;
}
