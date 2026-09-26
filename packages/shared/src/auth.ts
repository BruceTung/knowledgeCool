/**
 * 认证相关的共享类型 —— 前端登录页与成员管理页都要用。
 */
import type { SpaceRole } from './roles.js';

/** 当前登录用户的最小画像。**不含** password_hash / status 等敏感或内部字段。 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  department: string | null;
  avatarColor: string;
  isSuperAdmin: boolean;
}

/** 我可见的空间 + 我在此空间里的角色。 */
export interface VisibleSpace {
  id: string;
  name: string;
  slug: string;
  letter: string;
  color: string;
  role: SpaceRole;
}

/** `GET /auth/me` 的响应体(DESIGN.md §6.2:当前用户 + 可见空间列表)。 */
export interface MeResponse {
  user: AuthUser;
  spaces: VisibleSpace[];
}

/** 登录 / 初始化的请求体。 */
export interface CredentialsInput {
  email: string;
  password: string;
}

/** 首次初始化额外需要显示名。 */
export interface SetupInput extends CredentialsInput {
  name: string;
}

/**
 * 权限判定所需的「操作者」最小画像。
 *
 * 刻意只取这两个字段:服务端做权限检查时不需要更多,而且单测可以直接
 * 构造一个字面量对象,不必伪造整个 `AuthUser`(`AuthUser` 天然满足本类型)。
 */
export type Actor = Pick<AuthUser, 'id' | 'isSuperAdmin'>;

