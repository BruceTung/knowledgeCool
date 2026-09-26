import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '@knowledgecool/shared';

import type { AuthenticatedRequest } from './authenticated-request.js';

/**
 * 取出当前登录用户。
 *
 * 只在受 AuthGuard 保护的路由上使用(即没有 @Public() 的路由),
 * 否则 `request.user` 是 undefined。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
