import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

import { API_PREFIX } from './common/constants.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

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
