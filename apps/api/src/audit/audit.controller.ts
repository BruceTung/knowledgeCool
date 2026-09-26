import { Controller, Get, Query } from '@nestjs/common';
import { AUDIT_PAGE_SIZE, type AuditLogPage } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { AuditService } from './audit.service.js';

/**
 * 审计日志查询(DESIGN.md §6.2)。
 *
 * 可见范围的计算在 service 里做(按"我拥有所有权的节点子树"),不在 controller ——
 * 这样规则只有一处实现。
 *
 * v2.0 去掉了 `spaceId` 参数:范围现在由**我拥有哪些节点**决定,
 * 不由"我选了哪个空间"决定。传空间 id 反而会绕开那条规则。
 */
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: { id: string; isSuperAdmin: boolean },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogPage> {
    const parsed = limit === undefined ? AUDIT_PAGE_SIZE : Number.parseInt(limit, 10);
    return this.audit.list(
      { id: user.id, isSuperAdmin: user.isSuperAdmin },
      {
        ...(cursor === undefined || cursor === '' ? {} : { cursor }),
        ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
      },
    );
  }
}
