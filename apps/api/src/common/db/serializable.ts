import { AppError } from '../errors/app-error.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * 跑一个「先数一数、再写」的事务。
 *
 * **为什么要 Serializable 而不是默认隔离级别**:这类场景的典型形状是
 * 「count 一下还有几个管理员,再删掉一个」或「查一下目标父节点在不在自己子树里,再改路径」。
 * ReadCommitted 下两个并发请求会各自读到同一个旧状态然后各写一次 —— 每一步都"合法",
 * 结果却是空间零管理员 / 页面树成环。这类 bug 不会报错,只会让数据慢慢烂掉。
 *
 * **代价**是可能遇到写冲突。这里把它收敛成 409 让客户端重试,
 * 而不是当成 500 抛出去 —— 冲突是这套方案的正常现象,不是故障。
 *
 * ⚠️⚠️ **"写冲突"有两种形状,必须都认**(v4.13 修,见 `isDriverAdapterWriteConflict`)。
 */
export async function runSerializable<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(work, { isolationLevel: 'Serializable' });
  } catch (error: unknown) {
    if (isSerializationFailure(error)) {
      throw AppError.versionConflict('并发操作冲突,请重试');
    }
    throw error;
  }
}

/** 事务写冲突 / 死锁。Serializable 下可能遇到,是正常的。 */
export function isSerializationFailure(error: unknown): boolean {
  if (hasPrismaCode(error, 'P2034')) return true;
  return isDriverAdapterWriteConflict(error);
}

/**
 * ⚠️⚠️ v4.13:**Prisma 7 的驱动适配器路径不走 P2034。**
 *
 * 实测(8 个并发 `POST /auth/setup`,在隔离的临时库上连跑 6 轮):落败的请求里
 * 既有 409(被 `hasPrismaCode(error,'P2034')` 认出来的),也有 **500** ——
 * 而 500 的堆栈是:
 *
 * ```
 *   DriverAdapterError: TransactionWriteConflict
 *     at PgTransaction.onError (@prisma/adapter-pg/dist/index.mjs:666:11)
 *     at async runSerializable (common/db/serializable.js:15:16)
 * ```
 *
 * 根因:`@prisma/adapter-pg` 把 Postgres 的
 *   · `40001`(serialization_failure)
 *   · `40P01`(deadlock_detected)
 * 统一映射成一个 `DriverAdapterError`,其 `cause.kind === 'TransactionWriteConflict'`
 * —— 它**没有** `code: 'P2034'`。于是旧判断漏掉它,冲突被当成 500 抛出去。
 *
 * 影响面**不止 setup**:`runSerializable` 的每一个调用点都会中招 ——
 * 正文保存、移动节点、权限变更。表现是"两个人同时改同一篇,其中一个看到
 * **服务器内部错误**";而它本该是 409「该内容已被他人修改,请刷新后重试」。
 * 前端恰恰是按 `VERSION_CONFLICT` 这个码弹冲突横幅的 —— 拿到 500 就会走
 * "保存失败,继续输入会自动重试",而那个重试**永远不会成功**。
 *
 * ⚠️ 判"这是什么错误"要看**驱动适配器自己的类型**,不能用 `instanceof`:
 * 那是 `@prisma/driver-adapter-utils` 内部的类,本项目没直接依赖它。
 * 仍然用**鸭子类型**判 `name` + `cause.kind` —— 与 `hasPrismaCode` 同一条纪律。
 */
export function isDriverAdapterWriteConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; cause?: unknown };
  if (candidate.name !== 'DriverAdapterError') return false;
  if (typeof candidate.cause !== 'object' || candidate.cause === null) return false;
  return (candidate.cause as { kind?: unknown }).kind === 'TransactionWriteConflict';
}

/** 唯一约束冲突(Prisma P2002)。 */
export function isUniqueViolation(error: unknown): boolean {
  return hasPrismaCode(error, 'P2002');
}

/**
 * 用**鸭子类型**判 Prisma 错误码,而不是 `instanceof PrismaClientKnownRequestError`。
 *
 * 原因:Prisma 7 换了生成器(`prisma-client`),生成物导出的错误类名不保证跨版本稳定;
 * 而 `code` 字段是驱动层的稳定契约。这样写不会被一次 Prisma 升级打断。
 */
export function hasPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === code;
}
