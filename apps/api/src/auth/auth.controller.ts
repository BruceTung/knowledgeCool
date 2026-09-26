import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser, MeResponse } from '@knowledgecool/shared';
import type { Request, Response } from 'express';

import { SESSION_COOKIE_NAME } from '../common/constants.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { CurrentUser } from './current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { SetupDto } from './dto/setup.dto.js';
import { AllowDuringPasswordChange } from './password-change-allowed.decorator.js';
import { Public } from './public.decorator.js';

/**
 * 认证接口(DESIGN.md §6.2)。实际路径带全局前缀:`/api/v1/auth/...`
 *
 * ⚠️ v2.2 变化:
 *   - 登录 / 初始化用**工号**,不是邮箱
 *   - 新增 `POST /change-password`
 *   - `GET /me` 返回组织归属,不再返回"可见空间列表"
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 前端初始化引导页需要知道「该显示创建管理员还是该显示登录」。
   * 只暴露一个布尔值,不泄露用户数量等细节。
   */
  @Public()
  @Get('setup-state')
  @HttpCode(HttpStatus.OK)
  async setupState(): Promise<{ required: boolean }> {
    return { required: !(await this.auth.isInitialized()) };
  }

  /** 首次初始化:仅当库中无用户时可用。成功后直接登录。 */
  @Public()
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  async setup(
    @Body() dto: SetupDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const issued = await this.auth.setup(dto, sessionMetaOf(request));
    this.writeSessionCookie(response, issued.token, issued.expiresAt);
    return issued.user;
  }

  /**
   * 登录。
   *
   * ⚠️ 这里**允许** `mustChangePassword` 的用户登录成功 ——
   * 否则他连改密页都进不去。拦截发生在后续请求上(见 `AuthGuard`)。
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const issued = await this.auth.login(dto, sessionMetaOf(request));
    this.writeSessionCookie(response, issued.token, issued.expiresAt);
    return issued.user;
  }

  /**
   * 改密。
   *
   * ⚠️ **必须标注 `@AllowDuringPasswordChange()`** —— 否则守卫会把这条请求
   * 也一起 403 掉,用户被锁死在改密页里(§6.1.2)。
   */
  @Post('change-password')
  @AllowDuringPasswordChange()
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(user.id, dto);
  }

  /**
   * 登出。
   *
   * 同样在白名单里:一个未改密的人应该有权退出,而不是被困在改密页。
   */
  @Post('logout')
  @AllowDuringPasswordChange()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // 传 actorId:审计里"谁登出了"比"发生过一次登出"有用得多
    await this.auth.logout(request.sessionToken, request.user.id);
    // 清 Cookie 时属性必须与写入时一致,否则浏览器不会覆盖掉原来那个。
    response.clearCookie(SESSION_COOKIE_NAME, this.cookieBaseOptions());
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user.id);
  }

  // ---------------- 私有 ----------------

  private cookieBaseOptions(): {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: string;
  } {
    return {
      httpOnly: true,
      sameSite: 'lax',
      // 默认跟随 NODE_ENV=production;走 http 访问时必须显式关掉,
      // 否则浏览器不会回传 Cookie。详见 DESIGN.md §6.1.1 的运维注意。
      secure: this.config.get<boolean>('sessionCookieSecure') ?? false,
      path: '/',
    };
  }

  private writeSessionCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(SESSION_COOKIE_NAME, token, {
      ...this.cookieBaseOptions(),
      expires: expiresAt,
    });
  }
}

function sessionMetaOf(request: Request): { userAgent?: string; ip?: string } {
  const userAgent = request.get('user-agent');
  return {
    userAgent: userAgent === undefined ? undefined : userAgent.slice(0, 500),
    ip: request.ip,
  };
}
