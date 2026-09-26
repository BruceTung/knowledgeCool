import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/errors/app-error.js';
import { SESSION_COOKIE_NAME } from '../common/constants.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * 全局鉴权守卫(默认安全)。
 *
 * 「最小可见」原则(§5.3)在这里的第一道体现:
 * 未登录、会话过期、会话被吊销、账号被停用 —— 一律返回同一个 401,
 * 不告诉调用方具体是哪种情况。
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

    request.user = user;
    request.sessionToken = token;
    return true;
  }
}
