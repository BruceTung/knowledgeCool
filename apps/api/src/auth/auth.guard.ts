import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SESSION_COOKIE_NAME } from '../common/constants.js';
import { AppError } from '../common/errors/app-error.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { AuthService } from './auth.service.js';
import { PASSWORD_CHANGE_ALLOWED_KEY } from './password-change-allowed.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * 全局鉴权守卫(默认安全)。
 *
 * 未登录、会话过期、会话被吊销、账号被停用或已离职 —— 一律返回同一个 401,
 * 不告诉调用方具体是哪种情况。
 *
 * ## ⚠️ 首登强制改密的拦截就在这里
 *
 * 这是 v2.2 最容易做错的一处:**只在前端跳到改密页是无效的** ——
 * 用户手工敲一个别的 URL 就绕过去了。所以拦截必须落在服务端,
 * 而且必须落在**守卫**上,而不是某个 controller 里:
 * 守卫覆盖所有路由,将来新增接口不会漏。
 *
 * 白名单目前三条(改密、登出、读自己的画像),由 `@AllowDuringPasswordChange()`
 * 显式标注。没有标注的接口,一律 403 `PASSWORD_CHANGE_REQUIRED`。
 *
 * ⚠️ `GET /auth/me` **必须**在白名单里:前端要靠它读出 `mustChangePassword`
 * 才知道该把人送去改密页。漏了它的表现是前端显示「无法连接到服务」,
 * 用户连改密页都进不去 —— 这条在实跑验收时才发现,已补上。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // cookie-parser 已把 Cookie 解析到 request.cookies。
    // 这里用 unknown 再收窄,避免给 express 的 any 开洞。
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[SESSION_COOKIE_NAME];

    if (typeof token !== 'string' || token === '') {
      throw AppError.unauthorized();
    }

    const user = await this.auth.resolveUserBySessionToken(token);
    if (user === null) {
      throw AppError.unauthorized();
    }

    if (user.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_ALLOWED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (allowed !== true) {
        throw new AppError('PASSWORD_CHANGE_REQUIRED');
      }
    }

    request.user = user;
    request.sessionToken = token;
    return true;
  }
}
