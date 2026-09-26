import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 客户端。
 *
 * **Prisma 7 起,连接数据库必须经由 driver adapter**(内置查询引擎的直连方式已移除)。
 * 这里用 @prisma/adapter-pg,它底层是 node-postgres 的连接池。
 * 生成器 `prisma-client` 产出的是 TypeScript 源码,不是编译好的 JS ——
 * 所以它放在 src/generated 下,由本项目的 tsc 一起编译(见 schema.prisma 头部注释)。
 *
 * ⚠️ 刻意**不在 onModuleInit 里 $connect()**:
 * 启动不依赖数据库可达。理由 ——
 *   - compose 里 api 与 postgres 同时起,PG 初始化要几秒;若启动即连,api 会崩溃重启,
 *     看起来像"部署失败",实际只是竞态。
 *   - 存活探针 /health 与就绪探针 /health/ready 的语义因此才干净:
 *     前者回答"进程活着吗",后者回答"依赖都通吗"。
 *   - 权限缓存、检索本来就允许在依赖降级时失败(§3.2:Redis 不作为唯一数据源)。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('databaseUrl');

    if (connectionString === undefined || connectionString === '') {
      // 快速失败:配置缺失是部署错误,不该等到第一次查询才暴露。
      throw new Error('DATABASE_URL 未配置,Prisma 无法初始化');
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }

  /** 健康检查用:确认连接池真的能拿到连接并执行查询。 */
  async ping(): Promise<void> {
    await this.$queryRawUnsafe('select 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch((error: unknown) => {
      this.logger.warn(`关闭数据库连接时出错:${String(error)}`);
    });
  }
}
