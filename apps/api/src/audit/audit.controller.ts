import { Controller, Get, Inject, Query } from '@nestjs/common';
import { AUDIT_PAGE_SIZE, type AuditLogPage } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuditService } from './audit.service.js';

/**
 * 审计日志查询(DESIGN.md §6.2)。
 *
 * 授权在 service 里做(`audit.view` 能力),不在 controller 里 ——
 * 这样"跨空间只给超管"这类规则只有一处实现。
 */
@Controller('audit-logs')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedRequest['user'],
    @Query('spaceId') spaceId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogPage> {
    const parsed = limit === undefined ? AUDIT_PAGE_SIZE : Number.parseInt(limit, 10);
    return this.audit.list(
      { id: user.id, isSuperAdmin: user.isSuperAdmin },
      {
        ...(spaceId === undefined || spaceId === '' ? {} : { spaceId }),
        ...(cursor === undefined || cursor === '' ? {} : { cursor }),
        ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
      },
    );
  }
}
