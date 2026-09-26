import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'kc:isPublic';

/**
 * 标记某个路由**不需要登录**。
 *
 * AuthGuard 是全局守卫(在 AuthModule 里用 APP_GUARD 注册),所以默认一切接口都要登录。
 * 这是刻意的「默认安全」:新增接口时忘了加守卫,结果是「访问不了」而不是「裸奔」。
 * 需要放行的(健康检查、登录、初始化)显式标 @Public()。
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
