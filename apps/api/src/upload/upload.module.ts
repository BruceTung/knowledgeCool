import { Module } from '@nestjs/common';

import { UploadController } from './upload.controller.js';
import { UploadThrottleService } from './upload-throttle.js';

/**
 * 附件上传模块(M4)。
 *
 * 不需要 AuthModule:上传要登录这件事由**全局 AuthGuard** 保证,
 * 这里没有 @Public(),所以默认就是「必须登录」。
 *
 * ⚠️ v4.37 起多一个 provider:`UploadThrottleService`(按用户的速率限制)。
 * 它依赖 `RedisService`,而 `RedisModule` 是 `@Global()` 的,所以不必 import。
 * 为什么需要它见 upload-throttle.ts —— 实测 40 次连传 226ms 全部成功。
 */
@Module({
  controllers: [UploadController],
  providers: [UploadThrottleService],
})
export class UploadModule {}
