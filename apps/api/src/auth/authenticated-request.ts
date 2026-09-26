import type { AuthUser } from '@knowledgecool/shared';
import type { Request } from 'express';

/**
 * 通过 AuthGuard 之后的请求。`user` 由守卫写入,
 * 所以凡是带 @CurrentUser() 的处理器都可以认为它一定存在。
 */
export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  /** 原始会话 token,登出时需要它来定位并删除会话行。 */
  sessionToken: string;
}
