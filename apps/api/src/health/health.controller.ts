import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@knowledgecool/shared';
import type { Response } from 'express';

import { HealthService } from './health.service.js';

/**
 * 健康检查接口(无需登录 —— 探针不该带凭证)。
 *
 * 注意:这两个接口受全局前缀影响,实际路径是 /api/v1/health 与 /api/v1/health/ready。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * 存活探针。**永远**返回 200,只要进程还能响应。
   * DESIGN.md §9 M1 的验收口径就是这一条。
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  liveness(): HealthResponse {
    return this.health.liveness();
  }

  /**
   * 就绪探针。依赖不全时返回 503 —— 用 passthrough 让 Nest 保留我们返回的响应体,
   * 只覆盖状态码,这样编排器既能看到状态码,运维也能看到是哪一个依赖挂了。
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const { httpStatus, body } = await this.health.readiness();
    res.status(httpStatus);
    return body;
  }
}
