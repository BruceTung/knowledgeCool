import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { loadConfiguration } from './config/configuration.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommentModule } from './comment/comment.module.js';
import { HealthModule } from './health/health.module.js';
import { PageModule } from './page/page.module.js';
import { PermissionModule } from './permission/permission.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SearchModule } from './search/search.module.js';
import { SpaceModule } from './space/space.module.js';
import { UploadModule } from './upload/upload.module.js';

/**
 * 应用根模块。
 *
 * 环境变量加载顺序:apps/api/.env.local → apps/api/.env → 仓库根 .env → 进程环境。
 * 前两者是本地开发用;容器里由 docker-compose 直接注入进程环境。
 *
 * 模块依赖方向(单向,无环):
 *
 *   SpaceModule ──┐
 *                 ├─→ AuditModule ──┐
 *                 │                 ├─→ PermissionModule ──┬─→ PageModule ──→ CommentModule
 *                 └─────────────────┘                      └─→ SearchModule
 *
 * 页面、评论、检索三处都经 PermissionModule 做鉴权 ——
 * 权限判定只应该有一条路径(§12:它是"错了不会立刻报错"的头号高危逻辑)。
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
    AuditModule,
    PermissionModule,
    PageModule,
    CommentModule,
    SearchModule,
    UploadModule,
    HealthModule,
  ],
})
export class AppModule {}
