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
 * **`AuthGuard` 注册为 `APP_GUARD`(全局守卫)**,所以默认所有接口都需要登录;
 * 要放行的用 `@Public()` 显式标注。这是「默认安全」的选择:
 * 新增接口时忘记加守卫的后果是「访问不了」,而不是「未授权可访问」。
 *
 * 全局守卫同时承担**首登强制改密**的拦截(§6.1.2)—— 这是刻意的:
 * 放在守卫上意味着**新增接口不会漏**,而放在各个 controller 里一定会漏。
 *
 * `PasswordService` 一并导出:组织模块「建号」时要哈希初始密码,
 * 把它当成可复用的密码原语导出,而不是让别的模块自己 new 一个
 * (那样两个模块会各自持有一份配置)。
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, SessionService, PasswordService],
})
export class AuthModule {}
