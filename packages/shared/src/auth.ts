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
 *
 * ⚠️ 这里也**没有** `mustChangePassword`(v2.4 删掉的)。
 * 理由是它在前端恒为 `false`:**能拿到这个对象,就说明会话已建立,
 * 而首登不发会话**。留一个永远是 false 的字段只会让人以为它还有用。
 * 服务端自己需要这个判断(守卫的纵深防御),用的是内部的 `SessionUser`。
 */
export interface AuthUser {
  id: string;
  employeeNo: string;
  name: string;
  avatarColor: string;
  isSuperAdmin: boolean;
  /** 已离职 / 已停用的用户**不能登录**;这个字段只用于展示(如成员列表) */
  status: 'active' | 'disabled' | 'departed';
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
   * 我的组织归属 —— **不是"可见节点列表"**。
   *
   * 为什么不是可见列表:默认读是全员开放的(§5.3 规则一),所以"可见集合"
   * 在绝大多数情况下就是全部节点,列出来没有意义;而 v2.12 的受限节点
   * 走的是**逐节点判定**,它的可见集合算不出一个稳定的列表来。
   * 前端要"我现在能看什么",拿 `GET /org/tree` —— 那份是服务端过滤过的。
   */
  scopes: MyScope[];
}

/** 登录 / 初始化的请求体。**v2.2 起用工号,不是邮箱。** */
export interface CredentialsInput {
  employeeNo: string;
  password: string;
}

/**
 * 首次初始化额外需要姓名。
 */
export interface SetupInput extends CredentialsInput {
  name: string;
}

/**
 * 登录结果 —— **两种情况,不是一种**。
 *
 * ⚠️ v2.4 起,首次登录(`mustChangePassword` 为真)**不建立会话**:
 * 不写 Cookie、不产生 `sessions` 行,只返回一个一次性 `setupToken`。
 *
 * ## 为什么必须这样
 *
 * 旧实现是"先正常登录、再用守卫拦住所有业务接口"。结果这个人处在一个
 * **谁都不想要的状态**:他既进不去系统(每条业务接口都 403),
 * 又退不出登录态(连登录页都回不去,因为"已经登录"了)。
 * 用户的原话是:「用户第一次登录,不应该记录登录状态,
 * 重置完密码以后,应该要用户重新登录才对」。
 *
 * 所以现在的语义是干净的:**改密之前,你没有登录**。
 * 你只有一个 10 分钟有效、只够改一次密码的凭证。
 */
export type LoginResponse =
  | {
      kind: 'session';
      user: AuthUser;
      expiresAt: string;
    }
  | {
      kind: 'password-change-required';
      /** 让改密页能显示"你在为哪个工号改密" */
      employeeNo: string;
      name: string;
      /** 一次性凭证。签名过的短期 token,服务端不存 —— 见 `setup-token.ts` */
      setupToken: string;
      setupTokenExpiresAt: string;
    };

/**
 * 首次改密 —— **凭登录时拿到的一次性凭证,不要当前密码**。
 *
 * 为什么不要当前密码:登录那一步已经用初始密码验过身份了,再要一次是重复。
 * 而凭证本身是一次性的、10 分钟过期、只对签发它的那个用户有效。
 */
export interface InitialPasswordInput {
  setupToken: string;
  newPassword: string;
}

/**
 * 已登录用户主动改密。
 *
 * `currentPassword` 必填 —— 这里的会话可能是被他人接管的
 * (比如电脑没锁屏),多要一次密码能挡住一部分。
 * ⚠️ 首次强制改密**不走这个类型**,走 `InitialPasswordInput`。
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
