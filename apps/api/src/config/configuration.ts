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
   * HTTPS 尚未启用(DESIGN.md §2.4 要求内网也上 HTTPS),在那之前若走 http 访问(例如本机 compose 验收),
   * 必须显式设 SESSION_COOKIE_SECURE=false,否则浏览器不会回传 Cookie。
   */
  sessionCookieSecure: boolean;
  /**
   * 会话与短期凭证的签名密钥。
   *
   * 用途:首登改密的一次性凭证(`signSetupToken`);阶段二协同网关签短期 JWT
   * 也会用它(§6.1.1 把它留给那个用途,现在又被首登改密借用了)。
   *
   * ⚠️ **没有默认值** —— 部署时必须显式配置(compose 里用
   * `${SESSION_SECRET:?...}` 强制)。为空时首登改密**不会降级放行**,
   * 而是明确报错 —— 降级会让这条链路静默失效,那是更坏的结果。
   */
  sessionSecret: string;
  /**
   * 登录失败多少次后锁定账号(小于等于 0 表示关闭锁定)。
   *
   * 默认 5。这条是阶段一最实际的加固:初始密码统一是 123456、工号可枚举,
   * 没有它的话暴力破解是不限次数的。见 auth/login-throttle.ts。
   */
  loginMaxAttempts: number;
  /** 锁定时长(分钟)。默认 15。 */
  loginLockMinutes: number;
  /**
   * 同一来源 IP 在窗口内允许的**失败**次数(小于等于 0 表示关闭)。
   *
   * 默认 100。只数失败,成功不计 —— 否则早上集体登录会把办公室 IP 顶掉。
   * 内网常多人共用一个出口 IP,所以这个值刻意给得宽,可以调大或关闭。
   */
  loginIpMaxFailures: number;
  /** IP 限速窗口(分钟)。默认 15。 */
  loginIpWindowMinutes: number;
  /**
   * 上传窗口内允许的次数(小于等于 0 表示关闭)。
   *
   * 默认 30。实测过没有它的后果:连传 40 次、**226ms 全部成功**,
   * 平均 5.7ms 一次 —— 一个已登录账号一分钟能写进几 GB。
   * 单文件 10MB 的上限拦不住"次数"。见 upload/upload-throttle.ts。
   */
  uploadMaxPerWindow: number;
  /** 上传限速窗口(分钟)。默认 5。 */
  uploadWindowMinutes: number;
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
    /*
      ⚠️⚠️ v4.15:**生产环境没有默认值** —— 这是为了让 app-setup 里那道
      "WEB_ORIGIN 未配置就报错"的硬失败**真的可达**。

      原来这里无条件兜底成 `http://localhost:5173`,于是 `app-setup` 里
      `if (allowedOrigins.length === 0) throw …` 那段**是死代码**:
      兜底值本身非空,条件永远不成立 —— 生产上忘了配 `WEB_ORIGIN` 时,
      服务**照常启动**,只是 CORS 白名单里只有 `http://localhost:5173`。
      表现是:浏览器访问真实地址时被 CORS 拦掉,而**服务端一切正常**
      (curl 能通、日志没报错)—— 排查方向会被引到前端或网络上去。

      现在:生产必须显式配;开发形态仍保留 `localhost:5173` 的便利
      (与 `pnpm dev` 的 Vite 端口一致),不打扰本地开发。
    */
    webOrigin: process.env.WEB_ORIGIN ?? (isProduction ? '' : 'http://localhost:5173'),
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://knowledgecool:knowledgecool@localhost:5432/knowledgecool?schema=public',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    uploadDir: process.env.UPLOAD_DIR ?? './data/uploads',
    appVersion: process.env.APP_VERSION ?? '0.1.0',
    sessionTtlHours: toInt(process.env.SESSION_TTL_HOURS, 24 * 30),
    sessionCookieSecure: toBool(process.env.SESSION_COOKIE_SECURE, isProduction),
    // 空字符串表示未配置 —— 由使用方(首登改密)决定怎么处理,这里不做兜底默认值。
    sessionSecret: process.env.SESSION_SECRET ?? '',
    uploadMaxPerWindow: toInt(process.env.UPLOAD_MAX_PER_WINDOW, 30),
    uploadWindowMinutes: toInt(process.env.UPLOAD_WINDOW_MINUTES, 5),
    loginMaxAttempts: toInt(process.env.LOGIN_MAX_ATTEMPTS, 5),
    loginLockMinutes: toInt(process.env.LOGIN_LOCK_MINUTES, 15),
    loginIpMaxFailures: toInt(process.env.LOGIN_IP_MAX_FAILURES, 100),
    loginIpWindowMinutes: toInt(process.env.LOGIN_IP_WINDOW_MINUTES, 15),
  };
}
