import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * 认证模块。
 *
 * **AuthGuard 注册为 APP_GUARD(全局守卫)**,所以默认所有接口都需要登录;
 * 需要放行的用 @Public() 显式标注。这是「默认安全」的选择:
 * 新增接口时忘记加守卫的后果是「访问不了」,而不是「未授权可访问」。
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
