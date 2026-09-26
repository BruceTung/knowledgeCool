import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser, MeResponse } from '@knowledgecool/shared';
import type { Request, Response } from 'express';

import { SESSION_COOKIE_NAME } from '../common/constants.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { CurrentUser } from './current-user.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import { SetupDto } from './dto/setup.dto.js';
import { Public } from './public.decorator.js';

/**
 * 认证接口(DESIGN.md §6.2)。
 *
 * 实际路径带全局前缀: /api/v1/auth/...
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 前端初始化引导页需要知道「该显示创建管理员还是该显示登录」。
   * 这是 v1.4 新增的公开接口:DESIGN §6.2 原表里没有它,但 §7.2 的 /setup 路由
   * 需要这个信息才能正确渲染(否则只能靠「试着提交并接住 403」)。
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

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(request.sessionToken);
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
      // 默认跟随 NODE_ENV=production;TLS 落地(M6)之前走 http 时需显式关掉,
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
