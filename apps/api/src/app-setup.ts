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
 * 应用装配 —— main.ts 与 e2e 测试**共用同一份**配置。
 *
 * 抽出这个函数是为了消除一类很容易发生、又很难发现的偏差:
 * 测试里手写一套 pipe/filter/prefix,生产里是另一套,于是测试全绿而线上 500。
 * 只要装配逻辑只有一份,e2e 测的就真的是生产行为。
 */
export function configureApp(app: INestApplication): void {
  // 统一前缀 /api/v1(DESIGN.md §6.1)。Nginx 把 /api 反代到本进程。
  app.setGlobalPrefix(API_PREFIX);

  // 会话用 HttpOnly Cookie 承载,所以必须解析 Cookie,并允许携带凭证的跨域。
  app.use(cookieParser());

  // 请求体解析。必须在路由注册之前完成。
  //
  // 这里用 Nest 的 `useBodyParser` 而**不是**从 express 里 import json():
  // express 只是 @nestjs/platform-express 的传递依赖,不是本项目的直接依赖,
  // 直接 import 在本地能跑(提升层里有),进了镜像就 ERR_MODULE_NOT_FOUND。
  // 踩过一次,所以改成走 Nest 自己的门面。
  const expressApp = app as Partial<NestExpressApplication>;
  if (typeof expressApp.useBodyParser !== 'function') {
    // 换到 Fastify 平台时会走到这里 —— 明确报错,而不是让上传/保存静默地失败
    throw new Error('本项目依赖 Express 平台的 body 解析能力,不能用其它平台适配器');
  }
  expressApp.useBodyParser('json', { limit: BODY_LIMIT });
  expressApp.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  const config = app.get(ConfigService);
  const webOrigin = config.get<string>('webOrigin');
  app.enableCors({
    origin: webOrigin === undefined ? true : webOrigin.split(',').map((item) => item.trim()),
    credentials: true,
  });

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
