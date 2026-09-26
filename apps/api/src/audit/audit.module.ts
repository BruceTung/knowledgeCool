import { Module } from '@nestjs/common';

import { SpaceModule } from '../space/space.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/**
 * 审计模块。
 *
 * 依赖 SpaceModule 只为了 `requireCapability('audit.view')` ——
 * 授权判定必须复用同一份能力矩阵,不能在这里另写一套。
 */
@Module({
  imports: [SpaceModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
