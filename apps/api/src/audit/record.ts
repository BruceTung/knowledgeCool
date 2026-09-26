/**
 * 审计日志的**写入**侧。
 *
 * ## 为什么写日志是一个函数而不是一个可注入的服务
 *
 * 审计是横切关注点:几乎每个业务服务都要写它。如果做成可注入的 `AuditService`,
 * 就会出现 `AuthModule → AuditModule → SpaceModule → AuthModule` 这类模块环
 * (AuditService 为了校验 `audit.view` 需要 SpaceService)。
 *
 * 拆成纯函数后依赖方向变成单向:任何服务只要手里有 `PrismaService` 就能写日志,
 * 不需要 import 任何模块。**读取**侧(AuditService + AuditController,需要查空间角色)
 * 才留在模块里。
 *
 * ## 一条铁律
 *
 * **写日志永远不能让业务失败。** 日志是旁路:它挂了不该让"保存成功"变成 500。
 * 所以这里吞掉所有异常,只记 warn。
 */

import { Logger } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const logger = new Logger('AuditRecord');

/** 写一条审计日志需要的全部信息。 */
export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * 记一条审计日志。
 *
 * ⚠️ 调用方**不要** `await` 到会阻塞用户响应的地方再失败 —— 这里已经吞了异常,
 * 但更稳的写法是在业务成功之后调用,并且不要为了日志而回滚事务。
 * (也刻意不放进业务事务:日志写失败不该把已经成功的业务操作一起回滚。)
 *
 * `detail` 里带上 `spaceId` 是有意的:审计查询要按空间过滤,
 * 而 `audit_logs` 表没有 `space_id` 列(加列意味着每个调用点都要填对,
 * 填漏一条就是一次越权可见)。见 `AuditService.spaceTargetFilter`。
 */
export async function recordAudit(prisma: PrismaService, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        detail: (entry.detail ?? {}) as Prisma.InputJsonValue,
        ip: entry.ip ?? null,
      },
    });
  } catch (error: unknown) {
    logger.warn(
      `审计日志写入失败(action=${entry.action} target=${entry.targetId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
