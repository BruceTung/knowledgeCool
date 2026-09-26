// Prisma 7 的配置入口(取代旧版 schema 里的 datasource.url)。
// 由 `prisma init` 生成后按本项目调整;CLI 会打印 "Loaded Prisma config from prisma7.config.ts"。
//
// 注意:Prisma 7 **不会**自动加载 .env,必须显式 import "dotenv/config"。
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
