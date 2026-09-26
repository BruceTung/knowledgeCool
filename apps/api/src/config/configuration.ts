/**
 * 环境配置。
 *
 * 刻意为每个连接串提供**本地开发默认值**:这样 `pnpm dev` 不需要先准备 .env
 * 也能把进程拉起来(DATABASE_URL 指向本机 5432,连不上只影响 /health/ready,
 * 不影响 /health)。生产与 compose 一律由环境变量覆盖。
 *
 * 注意:这里**没有**默认值的是 SESSION_SECRET —— M2 接会话时必须显式提供,
 * 免得开发期的临时值被带进生产。
 */

export interface AppConfiguration {
  nodeEnv: string;
  port: number;
  webOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  uploadDir: string;
  appVersion: string;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfiguration(): AppConfiguration {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: toInt(process.env.API_PORT ?? process.env.PORT, 3000),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://knowledgecool:knowledgecool@localhost:5432/knowledgecool?schema=public',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    uploadDir: process.env.UPLOAD_DIR ?? './data/uploads',
    appVersion: process.env.APP_VERSION ?? '0.1.0',
  };
}
