/**
 * 认证相关的共享类型。
 *
 * ⚠️ **v2.2 起登录标识是工号,不是邮箱。**
 * 并新增「首次登录强制改密」这条链路(见 §6.1.2)——
 * 它不是可选功能:全员初始密码相同,不强制改就等于全员同密码上线。
 */

import type { Actor } from './permission.js';

/**
 * 当前登录用户的最小画像。**不含** password_hash 等内部字段。
 *
 * 这里**没有**组织归属 —— 它在 `MeResponse.scopes` 里单独给,
 * 因为前端往往分两处用:顶栏显示"我是谁"、界面里判断"我属于哪一段"。
 */
export interface AuthUser {
  id: string;
  employeeNo: string;
  name: string;
  avatarColor: string;
  isSuperAdmin: boolean;
  /** 已离职 / 已停用的用户**不能登录**;这个字段只用于展示(如成员列表) */
  status: 'active' | 'disabled' | 'departed';
  /**
   * 是否必须先改密。
   *
   * 放在 `AuthUser` 上而不是 `MeResponse` 顶层,是因为**守卫每个请求都要看它**
   * (`request.user` 就是这个对象)。放在顶层的话,守卫还得为此多查一次库。
   */
  mustChangePassword: boolean;
}

/** 我的组织归属 —— 一条对应一个节点。一人可有多条。 */
export interface MyScope {
  nodeId: string;
  /** 形如 `技术部 / 后端组` */
  path: string;
}

/** `GET /auth/me` 的响应体(DESIGN.md §6.2)。 */
export interface MeResponse {
  user: AuthUser;
  /**
   * 我的组织归属。
   * **没有"可见空间列表"了** —— 所有节点对所有登录用户可见(§5.3 规则一)。
   */
  scopes: MyScope[];
}

/** 登录 / 初始化的请求体。**v2.2 起用工号,不是邮箱。** */
export interface CredentialsInput {
  employeeNo: string;
  password: string;
}

/** 首次初始化额外需要姓名。 */
export interface SetupInput extends CredentialsInput {
  name: string;
}

/**
 * 改密请求(首次强制改密与主动改密共用)。
 *
 * `currentPassword` 必填 —— 即便是首登强制改,也要证明是本人:
 * 会话可能被他人接管,多要一次密码能挡住一部分。
 */
export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/**
 * 权限判定所需的「操作者」最小画像。
 *
 * 定义在 `permission.ts`(权限逻辑的实际使用方),这里只转出 ——
 * 让后端从一处导入即可,不用记两个位置。
 */
export type { Actor };
