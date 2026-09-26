import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { loadConfiguration } from './config/configuration.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SpaceModule } from './space/space.module.js';

/**
 * 应用根模块。
 *
 * 环境变量加载顺序:apps/api/.env.local → apps/api/.env → 仓库根 .env → 进程环境。
 * 前两者是本地开发用;容器里由 docker-compose 直接注入进程环境。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfiguration],
      envFilePath: ['.env.local', '.env', '../../.env'],
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    SpaceModule,
    HealthModule,
  ],
})
export class AppModule {}
