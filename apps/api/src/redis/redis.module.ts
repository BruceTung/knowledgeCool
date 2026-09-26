import { Global, Module } from '@nestjs/common';

import { RedisService } from './redis.service.js';

/** 全局模块:权限缓存到处都要用,没必要逐模块 import。 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
