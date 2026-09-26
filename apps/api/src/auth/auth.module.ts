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
 * 全局守卫同时守着一条**纵深防御**:如果库里出现"仍有 `must_change_password`
 * 为真、却持有会话"的账号(旧数据、或将来某处写错),守卫会把该会话吊销并按
 * 未登录处理。v2.4 起首次登录**不再建立会话**,所以这个状态在正常流程里
 * 根本不会存在 —— 守卫这条分支是为了让它即便存在也进不来。
 *
 * `PasswordService` 一并导出:组织模块「建号」与「重置密码」都要哈希初始密码,
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
