/**
 * 首次改密的一次性凭证 —— DESIGN.md §6.1.2 / §6.1.3。
 *
 * ## 它解决什么
 *
 * 首次登录**不建立会话**(见 `LoginResponse` 的说明)。但"改密"这个动作
 * 总得证明"你是谁" —— 不能让人凭一个工号就把别人的密码改了。
 *
 * 所以登录成功后签发一个短凭证:10 分钟有效、只对签发它的那个用户有效、
 * 用完即作废(改密成功就换掉了密码,凭证里的用户已经被改成"不需再改密")。
 *
 * ## 为什么不用 Redis / 数据库存它
 *
 * Redis 在这个系统里是**可降级依赖**(权限缓存没了也能正常判定)。
 * 把"首次改密"这条必经之路挂在 Redis 上,等于给登录链路凭空加一个
 * 可用性约束 —— 而它本来不该有。
 *
 * 数据库则要新增一张表、外加一个清理过期行的定时任务。
 *
 * 用 HMAC 签名是**无状态**的:服务端只需要一个密钥,不存任何东西,
 * 进程重启也不影响手上这个凭证。密钥复用 `SESSION_SECRET` ——
 * 它本来就是为了签短期凭证准备的(阶段二的协同网关也用它)。
 *
 * ## 格式
 *
 * ```
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 * ```
 *
 * payload 里只有 `sub`(用户 id)与 `exp`(毫秒时间戳)——
 * **不放工号、不放密码、不放任何别的**。凭证泄露的后果被限定成
 * "10 分钟内能改这一个用户的密码";多放字段只会扩大泄露面。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 凭证有效期。
 *
 * 10 分钟够一个人读完提示、想一个新密码、输两遍。
 * 再长就只是白白扩大窗口 —— 这个凭证只在"刚用初始密码登录过"之后 10 分钟内合理。
 */
export const SETUP_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface SetupTokenPayload {
  /** 用户 id */
  sub: string;
  /** 过期时刻(毫秒时间戳) */
  exp: number;
}

function encode(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/** 签发。`now` 可注入,便于单测快进时间。 */
export function signSetupToken(
  userId: string,
  secret: string,
  now: number = Date.now(),
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now + SETUP_TOKEN_TTL_MS);
  const payload: SetupTokenPayload = { sub: userId, exp: expiresAt.getTime() };
  const encoded = encode(JSON.stringify(payload));
  return { token: `${encoded}.${sign(encoded, secret)}`, expiresAt };
}

/**
 * 校验。**返回用户 id,或 `null`。**
 *
 * ⚠️ 失败原因一律不区分(签名不对 / 过期 / 格式不对都返回 `null`)——
 * 调用方只会回一句"凭证无效或已过期"。区分原因等于给攻击者一个
 * 逐步逼近的反馈信号,而这对合法用户没有任何价值(他知道自己刚点了什么)。
 */
export function verifySetupToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (encoded === undefined || signature === undefined) return null;
  if (encoded === '' || signature === '') return null;

  // 定长比较,避免逐字节短路带来的时序侧信道。
  // 长度不等时直接拒 —— 此时 `timingSafeEqual` 会抛错。
  const given = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(sign(encoded, secret), 'utf8');
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { sub, exp } = parsed as { sub?: unknown; exp?: unknown };
  if (typeof sub !== 'string' || sub === '') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  // 边界:刚好到点算过期
  if (now >= exp) return null;

  return sub;
}
