import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  /**
   * 导出 CSV(v2.14)。
   *
   * ⚠️ 走的是**同一个可见范围** —— 导出绝不能绕过审计的访问控制,
   * 否则「页面上看不到、导出文件里全有」就是一次越权读取。
   */
  @Get('export')
  async export(
    @CurrentUser() user: { id: string; isSuperAdmin: boolean },
    @Query('action') action: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.audit.exportCsv(
      { id: user.id, isSuperAdmin: user.isSuperAdmin },
      action === undefined || action === '' ? {} : { action },
    );

    // 中文文件名要走 RFC 5987 的 filename*,否则下载下来是乱码
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = encodeURIComponent(`审计日志-${stamp}.csv`);
    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
      // 把「截断过」这件事也告诉调用方 —— 只靠文件内容看不出来
      .header('X-Audit-Exported', String(result.exported))
      .header('X-Audit-Capped', result.capped ? 'true' : 'false')
      .send(result.csv);
  }

  @Get()
  list(
    @CurrentUser() user: { id: string; isSuperAdmin: boolean },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
  ): Promise<AuditLogPage> {
    const parsed = limit === undefined ? AUDIT_PAGE_SIZE : Number.parseInt(limit, 10);
    return this.audit.list(
      { id: user.id, isSuperAdmin: user.isSuperAdmin },
      {
        ...(cursor === undefined || cursor === '' ? {} : { cursor }),
        ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
        ...(action === undefined || action === '' ? {} : { action }),
      },
    );
  }
}
