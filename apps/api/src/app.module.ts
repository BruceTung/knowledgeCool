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
 *   AuthModule ──→ OrgModule
 *   PermissionModule ─┬─→ NodeModule
 *                     ├─→ CommentModule
 *                     └─→ SearchModule
 *
 *   即:**除 AuthModule 之外,每个业务模块都只依赖 PermissionModule 判权**。
 * ```
 *
 * 三处刻意的收敛:
 *   1. **`PermissionModule` 不依赖任何业务模块** —— 它只读 `nodes` / `node_grants`
 *      / `node_readers` / `org_assignments` / `users` 五张表,所以谁都能依赖它,
 *      而它不会反过来依赖谁。这是"权限判定只有一条路径"的结构保证(§12)。
 *
 *      ⚠️ v4.24 更正:原文写"只读三张表"(少了 `node_readers` 与 `users`)。
 *      实测:一是读读者名单(`buildReadersView`),二是读用户(组织范围与在职状态)
 *      —— 见 `permission.service.ts`。
 *   2. **审计不在依赖图里** —— 写入是纯函数(`audit/record.ts`),
 *      任何模块只要手里有 `PrismaService` 就能写。做成可注入服务会立刻成环
 *      (审计读取侧要判权 → 判权要节点 → 节点要写审计)。
 *   3. **`SearchModule` 依赖 `PermissionModule`** —— v2.0~v2.11 它确实**不**依赖
 *      (那时检索不做权限过滤,因为读对全员开放);**v2.12 起又要了**:
 *      有了受限节点之后,检索必须逐条问"这一条他读不读得到",
 *      否则保密只挡住了树与详情,却从检索漏出去。
 *
 *      ⚠️ v4.24 更正:原文写"`SearchModule` 不再依赖 `PermissionModule`"——
 *      **与上面那张图、也与代码相反**(`search.module.ts` 里就是 `imports: [PermissionModule]`)。
 *      详见 `search.module.ts` 的说明。
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
