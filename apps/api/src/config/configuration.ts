/**
 * 环境配置。
 *
 * 刻意为每个连接串提供**本地开发默认值**:这样 `pnpm dev` 不需要先准备 .env
 * 也能把进程拉起来(DATABASE_URL 指向本机 5432,连不上只影响 /health/ready,
 * 不影响 /health)。生产与 compose 一律由环境变量覆盖。
 *
 * 注意:这里**没有**默认值的是 SESSION_SECRET —— 阶段一的会话是不透明 token
 * (强度来自随机性,不依赖密钥),该密钥留给阶段二协同网关签短期 JWT 用。
 * 详见 DESIGN.md §6.1.1。
 */

export interface AppConfiguration {
  nodeEnv: string;
  port: number;
  webOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  uploadDir: string;
  appVersion: string;
  /** 会话有效期(小时)。默认 30 天。 */
  sessionTtlHours: number;
  /**
   * 会话 Cookie 是否带 Secure 属性。
   * 默认跟随 NODE_ENV=production 打开(DESIGN.md §2.4 要求内网也上 HTTPS)。
   * TLS 要到 M6 才落地,在那之前若走 http 访问(例如本机 compose 验收),
   * 必须显式设 SESSION_COOKIE_SECURE=false,否则浏览器不会回传 Cookie。
   */
  sessionCookieSecure: boolean;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfiguration(): AppConfiguration {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  return {
    nodeEnv,
    port: toInt(process.env.API_PORT ?? process.env.PORT, 3000),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://knowledgecool:knowledgecool@localhost:5432/knowledgecool?schema=public',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    uploadDir: process.env.UPLOAD_DIR ?? './data/uploads',
    appVersion: process.env.APP_VERSION ?? '0.1.0',
    sessionTtlHours: toInt(process.env.SESSION_TTL_HOURS, 24 * 30),
    sessionCookieSecure: toBool(process.env.SESSION_COOKIE_SECURE, isProduction),
  };
}
