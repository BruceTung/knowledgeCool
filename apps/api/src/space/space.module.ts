import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { SpaceController } from './space.controller.js';
import { SpaceService } from './space.service.js';

/**
 * 空间与成员模块。
 *
 * 依赖 AuthModule 是因为要复用它导出的 `PasswordService` ——
 * 「邀请一个还不存在的邮箱」需要建号,建号就要哈希密码。
 * 这是当前唯一需要显式 import 的模块依赖;鉴权本身由全局 AuthGuard 承担,
 * 不需要在这里再注册一次。
 */
@Module({
  imports: [AuthModule],
  controllers: [SpaceController],
  providers: [SpaceService],
  exports: [SpaceService],
})
export class SpaceModule {}
