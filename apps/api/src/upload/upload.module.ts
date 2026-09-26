import { Module } from '@nestjs/common';

import { UploadController } from './upload.controller.js';

/**
 * 附件上传模块(M4)。
 *
 * 不需要 AuthModule:上传要登录这件事由**全局 AuthGuard** 保证,
 * 这里没有 @Public(),所以默认就是"必须登录"。
 */
@Module({
  controllers: [UploadController],
})
export class UploadModule {}
