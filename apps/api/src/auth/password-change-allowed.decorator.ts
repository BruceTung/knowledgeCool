import { SetMetadata } from '@nestjs/common';

/** 元数据键。守卫用 `getAllAndOverride` 读取。 */
export const PASSWORD_CHANGE_ALLOWED_KEY = 'kc:password-change-allowed';

/**
 * 标记「首登强制改密期间仍可调用」的接口。
 *
 * ⚠️ **这个白名单必须尽量短** —— 每加一个,就多一个"尚未改密的人能碰到的入口"。
 * 目前只有两个:`POST /auth/change-password`(改密本身)、`POST /auth/logout`(登出)。
 *
 * 为什么用装饰器而不是在守卫里硬编码路径:硬编码会在路由改名时
 * **静默失效** —— 要么守卫不再放行(用户被锁死在改密页,进不去也出不来),
 * 要么反过来放行了不该放的。装饰器至少能在改动时被 grep 到。
 */
export const AllowDuringPasswordChange = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PASSWORD_CHANGE_ALLOWED_KEY, true);
