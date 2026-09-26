/**
 * 健康检查 e2e —— M1 的验收口径就在这个文件里。
 *
 * 依赖被替换成桩:这个测试**不需要数据库、不需要 Redis** 就能跑。
 * 这正是它作为验收测试的价值 —— 在干净机器或 CI 上随时可跑。
 * 至于"真实依赖是否真的通",由 db:verify 脚本与 /health/ready 的运维观测负责。
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app-setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';

interface StubOptions {
  databaseUp?: boolean;
  redisUp?: boolean;
}

async function createApp(options: StubOptions = {}): Promise<INestApplication> {
  const { databaseUp = true, redisUp = true } = options;

  const prismaStub = {
    ping: vi.fn(() =>
      databaseUp ? Promise.resolve() : Promise.reject(new Error('连接被拒绝')),
    ),
    $disconnect: vi.fn(() => Promise.resolve()),
  };

  const redisStub = {
    ping: vi.fn(() => (redisUp ? Promise.resolve() : Promise.reject(new Error('ECONNREFUSED')))),
    onModuleDestroy: vi.fn(() => Promise.resolve()),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaStub)
    .overrideProvider(RedisService)
    .useValue(redisStub)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

describe('健康检查', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /api/v1/health(存活探针)', () => {
    it('进程活着就返回 200,且不依赖任何外部服务', async () => {
      // 依赖全挂的情况下也必须 200 —— 否则编排器会把健康的进程反复重启。
      app = await createApp({ databaseUp: false, redisUp: false });

      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(response.body).toMatchObject({ status: 'ok' });
      expect(typeof response.body.uptime).toBe('number');
      expect(typeof response.body.version).toBe('string');
    });

    it('路径带全局前缀 /api/v1;不带前缀时应 404', async () => {
      app = await createApp();

      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      await request(app.getHttpServer()).get('/health').expect(404);
    });

    it('404 的响应体也是统一错误形状(DESIGN.md §6.1)', async () => {
      app = await createApp();

      const response = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);

      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: '页面不存在或你没有访问权限',
        },
      });
    });
  });

  describe('GET /api/v1/health/ready(就绪探针)', () => {
    it('依赖全通时返回 200 且 status=ok', async () => {
      app = await createApp();

      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.components.database.status).toBe('up');
      expect(response.body.components.redis.status).toBe('up');
    });

    it('数据库不通时返回 503 并指明是哪个依赖挂了', async () => {
      app = await createApp({ databaseUp: false });

      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);

      expect(response.body.status).toBe('degraded');
      expect(response.body.components.database).toMatchObject({
        status: 'down',
        error: '连接被拒绝',
      });
      // Redis 正常,不能被误报成 down
      expect(response.body.components.redis.status).toBe('up');
    });

    it('Redis 不通时同样降级,但数据库仍报 up', async () => {
      app = await createApp({ redisUp: false });

      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);

      expect(response.body.components.redis.status).toBe('down');
      expect(response.body.components.database.status).toBe('up');
    });
  });
});
