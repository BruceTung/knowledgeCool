import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { API_PREFIX } from './common/constants.js';
import { AppError } from './common/errors/app-error.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { exceedsNestingDepth } from './common/json-depth.js';

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
 * 请求体 JSON 的**括号层数**上限 —— 在解析之前拦,见下面的 `verify`。
 *
 * 取 100 与 `MAX_DOC_DEPTH`(正文文档树的层数上限)**同一个量级但更宽松**:
 * 请求体外壳还会多套一两层(`{"content":{...}}`),所以这里必须比它大;
 * 但它远小于会爆栈的 ~1000 层,因此照样拦得住。
 *
 * ⚠️ 两个数不能互相取代:这个管"解析期别爆栈"(按括号数、不看语义),
 * `MAX_DOC_DEPTH` 管"文档树本身合不合理"(按 type/节点数,是语义校验)。
 */
const MAX_BODY_JSON_DEPTH = 120;

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
  /*
    ⚠️⚠️ v4.11:**解析前的深度预检 —— 必须挂在这里,不能挂业务层。**

    实测(发一份深度递增的合法 `{type:'doc'}` 树给 `PUT /nodes/:id/content`):
      深度  500  (15 KB) -> 403   走到了业务校验
      深度 1000  (30 KB) -> **500**
      浅结构、88 KB       -> 403   **同体积不崩**

    500 的堆栈落在 `@nestjs/common/utils/strip-proto-keys.util.js` ——
    **Nest 反序列化/剥离原型键**那一步,**比任何控制器代码都早**。
    所以 `ContentService.save` 里的 `checkDocStructure` 永远不会被执行:
    请求还没进业务层就爆栈了。(那条检查仍要有 —— 它管节点数上限与
    `type=doc` 这类**语义**校验,只是拦不住"解析期爆栈"。)

    */
  /*
      ⚠️ **不能走 body-parser 的 `verify`** ——
      `NestExpressBodyParserOptionsFor` 显式把它 `Omit` 掉了(Nest 自己要用它抓
      原始 body)。但那只在 `rawBody: true` 时才真的覆盖:`getBodyParserOptions`
      的源码是 `rawBody === true ? {...options, verify: rawBodyParser} : options`。
      本项目没有开 `rawBody`,所以传入的 `verify` 会被**原样保留** ——
      是类型挡住了而已,运行时是通的。所以这里加一次显式断言,并把理由写在上面。

      `verify` 拿到的是**原始 buffer**(那时还没 `JSON.parse`),因此可以用一次
      纯字符扫描数括号层数 —— 不建对象、不递归,再深的输入也不会让它自己爆栈。
    */
  expressApp.useBodyParser('json', {
    limit: BODY_LIMIT,
    verify: (_req: { url?: string }, _res: unknown, buf: Buffer) => {
      /*
        ⚠️⚠️ v4.39:**所有 JSON 正文都要扫,不能只扫 `/content`。**

        原来这里有一句 `if (!req.url?.includes('/content')) return;`,
        理由是「只有 /content 可能承载深层结构;其余请求体都很小,不必扫」。
        **那个理由是错的** —— 深度守卫要防的不是「正文语义上是不是一棵树」,
        而是「解析期别爆栈」。而爆栈发生在 Nest 的 strip-proto-keys 里,
        **任何** JSON 端点都会经过它。

        实测(隔离库,逐条打):

          路径                 深度   状态
          PUT /nodes/:id/content  3000   400 ✅ 被守卫拦住
          POST /nodes             3000   **500** ❌ RangeError: Maximum call stack size exceeded
          POST /nodes              200   400    (没到爆栈深度,所以看起来没事)

        也就是说:只要换一个 JSON 端点,同一个攻击就绕过去了 ——
        而 curl 一行就能做到,不需要任何特殊权限(只是「已登录」)。

        代价方面:这是**纯字符扫描、零分配、不递归**(见 json-depth.ts),
        每个请求体过一遍的开销远小于 JSON.parse 本身,没有必要为省它而留一个洞。
      */
      if (exceedsNestingDepth(buf.toString('utf8'), MAX_BODY_JSON_DEPTH)) {
        throw AppError.validation(`请求内容嵌套层级过深(超过 ${String(MAX_BODY_JSON_DEPTH)} 层)`);
      }
    },
  } as Parameters<typeof expressApp.useBodyParser<'json'>>[1]);
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
