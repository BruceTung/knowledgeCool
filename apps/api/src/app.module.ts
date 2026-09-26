import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommentModule } from './comment/comment.module.js';
import { loadConfiguration } from './config/configuration.js';
import { HealthModule } from './health/health.module.js';
import { NodeModule } from './node/node.module.js';
import { OrgModule } from './org/org.module.js';
import { PermissionModule } from './permission/permission.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SearchModule } from './search/search.module.js';
import { UploadModule } from './upload/upload.module.js';

/**
 * 应用根模块。
 *
 * 环境变量加载顺序:apps/api/.env.local → apps/api/.env → 仓库根 .env → 进程环境。
 * 前两者是本地开发用;容器里由 docker-compose 直接注入进程环境。
 *
 * ## 模块依赖方向(v2.0,单向无环)
 *
 * ```
 *   AuthModule ──→ OrgModule ──┐
 *                              ├─→ ...(都经 PermissionModule 判权)
 *   PermissionModule ─┬─→ NodeModule ──→ CommentModule
 *                     └─→ SearchModule
 * ```
 *
 * 三处刻意的收敛:
 *   1. **`PermissionModule` 不依赖任何业务模块** —— 它只读 `nodes` / `node_grants`
 *      / `org_assignments` 三张表,所以谁都能依赖它,而它不会反过来依赖谁。
 *      这是"权限判定只有一条路径"的结构保证(§12)。
 *   2. **审计不在依赖图里** —— 写入是纯函数(`audit/record.ts`),
 *      任何模块只要手里有 `PrismaService` 就能写。做成可注入服务会立刻成环
 *      (审计读取侧要判权 → 判权要节点 → 节点要写审计)。
 *   3. **`SearchModule` 不再依赖 `PermissionModule`** —— 检索不做权限过滤了(§8.3)。
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
    PermissionModule,
    NodeModule,
    OrgModule,
    CommentModule,
    SearchModule,
    AuditModule,
    UploadModule,
    HealthModule,
  ],
})
export class AppModule {}
