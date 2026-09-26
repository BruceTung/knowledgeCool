import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser, LoginResponse, MeResponse } from '@knowledgecool/shared';
import type { Request, Response } from 'express';

import { SESSION_COOKIE_NAME } from '../common/constants.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { CurrentUser } from './current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { InitialPasswordDto } from './dto/initial-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { SetupDto } from './dto/setup.dto.js';
import { Public } from './public.decorator.js';

/**
 * 认证接口(DESIGN.md §6.2)。实际路径带全局前缀:`/api/v1/auth/...`
 *
 * ⚠️ v2.4 的三处变化:
 *   1. **登录有两种结果**(`LoginResponse`)—— 需要先改密时不发会话,
 *      改发一次性 `setupToken`。所以 `login` 的返回类型不再是 `AuthUser`。
 *   2. 新增 `POST /initial-password`(首次改密,凭 `setupToken`,**不要原密码**)。
 *   3. **删掉了「改密期间白名单」装饰器** —— 不再存在"已登录但未改密"
 *      这种状态,白名单也就没有存在意义了(见 `AuthGuard`)。
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
   * 登录。**两种结果,见 `LoginResponse`。**
   *
   * - `kind: 'session'` → 建立会话,写 Cookie,前端进工作台
   * - `kind: 'password-change-required'` → **不写 Cookie**,返回一次性凭证,
   *   前端去改密页;改完必须用新密码重新登录
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.login(dto, sessionMetaOf(request));

    // ⚠️ 只有真正建立了会话才写 Cookie。
    // 首登那条路径**没有会话** —— 写了就等于"改密之前算已登录",
    // 而用户要的恰恰是"第一次登录不记录登录状态"。
    if (outcome.session !== undefined) {
      this.writeSessionCookie(response, outcome.session.token, outcome.session.expiresAt);
    }
    return outcome.response;
  }

  /**
   * **首次改密** —— 凭登录时拿到的一次性凭证,**不要原密码**。
   *
   * ⚠️ 公开接口(`@Public`)—— 因为调用它的人**还没有会话**。
   * 身份由 `setupToken` 证明:签名有效、未过期、且该用户仍处于"待改密"状态。
   *
   * 成功后**不建立会话**:用户要用新密码重新登录一次。
   * 这样"我设的密码真的能用"是当场验证的。
   */
  @Public()
  @Post('initial-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setInitialPassword(@Body() dto: InitialPasswordDto): Promise<void> {
    await this.auth.setInitialPassword(dto);
  }

  /**
   * **已登录用户**主动改密。需要当前密码。
   *
   * 与上面的 `/initial-password` 是两条路径,身份依据完全不同:
   * 这里靠会话 + 当前密码;那里靠一次性凭证。
   */
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(user.id, dto);
  }

  /** 登出。 */
  @Post('logout')
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

  /**
   * 当前用户 + 我的组织归属。
   *
   * 需要登录 —— 这现在是句废话,因为**每个接口都需要登录**
   * (白名单机制已随"半登录态"一起删除)。
   */
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
