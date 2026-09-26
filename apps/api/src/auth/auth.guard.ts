import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SESSION_COOKIE_NAME } from '../common/constants.js';
import { AppError } from '../common/errors/app-error.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * 全局鉴权守卫(默认安全)。
 *
 * 未登录、会话过期、会话被吊销、账号被停用或已离职 —— 一律返回同一个 401,
 * 不告诉调用方具体是哪种情况。
 *
 * ## ⚠️ v2.4:这里**不再有"首登强制改密"的白名单**
 *
 * 旧实现是「登录照样成功 → 守卫拦住其余接口 → 用装饰器白名单放行改密页要用的那几条」。
 * 那套机制绕来绕去,根子在于**首次登录也建立了会话** ——
 * 于是一个人能停在"已登录但什么都做不了"的半状态:进不去系统,
 * 也退不出去(连登录页都回不去)。
 *
 * 现在首次登录根本不建立会话(见 `LoginResponse` / `AuthService.login`),于是:
 *   - **不存在**"已登录但未改密"这种状态,白名单失去意义
 *   - 未改密的人手里只有一个 10 分钟的改密凭证;对业务接口而言他就是未登录
 *
 * 顺带消掉了一类 bug:白名单漏一条,用户就会卡在某个页面上
 * (v2.0 就漏过 `GET /auth/me`,表现是前端显示「无法连接到服务」)。
 * 整套机制没有之后,那种漏法不可能再发生。
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
      // **纵深防御。** 按当前流程,持有会话的用户不可能还处于"待改密"状态
      // (首登不发会话、建人不发会话、重置脚本会踢会话)。
      // 真出现了(例如有人手工改库),就吊销这个会话并按**未登录**处理 ——
      // 让半登录态不可能存在,而不是放他进来再逐个接口去判。
      await this.auth.revokeSession(token);
      throw AppError.unauthorized();
    }

    request.user = user;
    request.sessionToken = token;
    return true;
  }
}
