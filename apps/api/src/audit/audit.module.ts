import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/**
 * 审计模块(**读取侧**)。
 *
 * ⚠️ v2.0 起**不再依赖 `SpaceModule`**。旧版要靠它做 `requireCapability('audit.view')`,
 * 而新模型里"能看哪些日志"的判断就是"我拥有哪些节点的所有权" ——
 * 这个判断只需要 `PrismaService`,不需要任何其他服务的配合。
 *
 * 写入侧是纯函数(`record.ts`),不在本模块里。
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
