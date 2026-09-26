import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

/** 全局模块:几乎每个业务模块都要读库,逐模块 import 只会制造噪音。 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
