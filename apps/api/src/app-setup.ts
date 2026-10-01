import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { API_PREFIX } from './common/constants.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

/**
 * 请求体大小上限。
 *
 * ⚠️ Express 的 JSON 解析器**默认只有 100kb** —— 而正文上限是 2MB
 * (`CONTENT_JSON_MAX_BYTES`)。不显式抬高的话,任何超过 100kb 的文档
 * 保存时都会被 body-parser 直接拒掉,表现为"长文档存不进去而短文档正常",
 * 而且错误还是 500(见 all-exceptions.filter 里对解析错误的处理)。
 *
 * 留出余量给 JSON 外壳与转义:2MB 正文最坏情况转义后会膨胀若干倍。
 */
const BODY_LIMIT = '8mb';

/**
 * 应用装配 —— 启动路径**只有这一处**。
 *
 * 抽出这个函数是为了把 prefix / Cookie / 代理信任 / CORS / body 上限 / pipe / filter
 * 全部收在一处:这些设置里任何一条漏掉或写错,**都不会报错**,
 * 只会表现成某一类请求静默失效 —— 过长正文 500、Cookie 不回传、
 * `request.ip` 变成代理地址导致限流与审计失真。装配逻辑只有一份,才谈得上被审查。
 */
export function configureApp(app: INestApplication): void {
  // 统一前缀 /api/v1(DESIGN.md §6.1)。Nginx 把 /api 反代到本进程。
  app.setGlobalPrefix(API_PREFIX);

  // 会话用 HttpOnly Cookie 承载,所以必须解析 Cookie,并允许携带凭证的跨域。
  app.use(cookieParser());

  // Express 平台能力统一在这里取一次。下面几处都靠它,而且**每一处都要显式检查** ——
  // 换到 Fastify 平台时必须在启动那一刻就明确报错,而不是让上传/保存/限流静默地失效。
  const expressApp = app as Partial<NestExpressApplication>;

  // ⚠️ **必须显式信任反向代理,否则 `request.ip` 永远是 Nginx 容器的地址。**
  //
  // Express 默认**不读** `X-Forwarded-For` —— `req.ip` 给的是 TCP 对端地址。
  // 而生产拓扑是 `浏览器 → Nginx → api`,所以不设这一项时:
  //
  //   1. **登录限流退化成"全公司共用一个 IP 桶"**:`LOGIN_IP_MAX_FAILURES`
  //      (默认 100/15 分钟)会把所有同事算进同一个键 —— 15 分钟内累计失败 100 次,
  //      **所有人都被锁在门外**;同时它对"每个账号只试一次"的撞库撒网毫无作用
  //      (它数的是总量,不是来源)。
  //   2. **审计里的 IP 全是代理 IP**,`audit_logs.ip` / `sessions.ip` 失去意义,
  //      "谁从哪登录的"这个问题再也答不出来。
  //
  // 为什么是 `1` 而不是 `true`:`true` 表示**信任整条链**,于是一个客户端只要
  // 自己带一个 `X-Forwarded-For: 1.2.3.4` 就能伪造来源、绕过限流。
  // 这里只有一跳 Nginx(它用 `$proxy_add_x_forwarded_for`,会把真实地址**追加**在末尾),
  // 所以"信任 1 跳"既拿到真实地址,又不会被伪造值骗到。
  //
  // 拓扑前提:`docker-compose.yml` 里 **api 服务不 publish 端口**,外界只能经 Nginx。
  //
  // ⚠️ **"不可伪造"只在那个前提下成立。** 若请求能直达 api 端口(例如 `pnpm dev`
  // 裸跑 3000),TCP 对端就是调用方自己,他自带的 `X-Forwarded-For` 会落在真实地址
  // **左侧**,而"信任 1 跳"取的正是它 —— 也就是**调用方可以自选出口 IP**,
  // 那道 IP 限流形同虚设。结论:**生产必须保持 api 不 publish 端口**;
  // 开发形态下别指望 IP 门挡得住谁(按账号锁与 bcrypt 时序对齐不受这条影响)。
  if (typeof expressApp.set !== 'function') {
    throw new Error('本项目依赖 Express 平台的 trust proxy 能力,不能用其它平台适配器');
  }
  expressApp.set('trust proxy', 1);

  // 请求体解析。必须在路由注册之前完成。
  //
  // 这里用 Nest 的 `useBodyParser` 而**不是**从 express 里 import json():
  // express 只是 @nestjs/platform-express 的传递依赖,不是本项目的直接依赖,
  // 直接 import 在本地能跑(提升层里有),进了镜像就 ERR_MODULE_NOT_FOUND。
  // 踩过一次,所以改成走 Nest 自己的门面。
  if (typeof expressApp.useBodyParser !== 'function') {
    // 换到 Fastify 平台时会走到这里 —— 明确报错,而不是让上传/保存静默地失败
    throw new Error('本项目依赖 Express 平台的 body 解析能力,不能用其它平台适配器');
  }
  expressApp.useBodyParser('json', { limit: BODY_LIMIT });
  expressApp.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  const config = app.get(ConfigService);
  const webOrigin = config.get<string>('webOrigin') ?? '';
  // ⚠️ **不做"没配就放开所有来源"的兜底。**
  // 旧写法是 `webOrigin === undefined ? true : …`,而 `true` 配合 `credentials: true`
  // 会**反射任意来源**并允许带 Cookie —— 一个静默开着的洞,且它只在配置缺失时才生效,
  // 也就是只在最不被注意的时刻生效。这里改成明确报错。
  const allowedOrigins = webOrigin
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (allowedOrigins.length === 0) {
    throw new Error('WEB_ORIGIN 未配置 —— 不能用「放开所有来源」兜底(见 configuration.ts)');
  }
  app.enableCors({ origin: allowedOrigins, credentials: true });

  // 白名单剥离未声明字段,并拒绝多余字段 —— 防止越权字段被顺手写进库。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 唯一出错出口,保证前端只解析一种错误体(DESIGN.md §6.1)。
  app.useGlobalFilters(new AllExceptionsFilter());

  // 让容器发的 SIGTERM 触发 onModuleDestroy(Prisma / Redis 优雅关闭)。
  app.enableShutdownHooks();
}
