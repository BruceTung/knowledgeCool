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
 * **代价**是可能遇到写冲突(Prisma 的 P2034)。这里把它收敛成 409 让客户端重试,
 * 而不是当成 500 抛出去 —— 冲突是这套方案的正常现象,不是故障。
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

/** 事务写冲突 / 死锁(Prisma P2034)。Serializable 下可能遇到,是正常的。 */
export function isSerializationFailure(error: unknown): boolean {
  return hasPrismaCode(error, 'P2034');
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
