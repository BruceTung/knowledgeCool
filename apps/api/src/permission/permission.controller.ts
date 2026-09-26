import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type { AuthUser, GrantCandidate, NodeGrantsResponse } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SaveGrantsDto } from './dto/save-grants.dto.js';
import { PermissionService } from './permission.service.js';

/**
 * 授权接口。
 *
 * ⚠️ 两点与 v1.x 不同:
 *   1. 是**节点级**的,不是页面级 —— 空间与页面已合并为一棵树(§4.1)
 *   2. **没有 deny** —— 收回权限 = 把人从名单里删掉(§5.3)
 *
 * 权限设置做在**节点上的弹窗**里,而不是独立页面:节点会有几百个,
 * 不可能每个都配一个页面(§7.2)。
 */
@Controller()
export class PermissionController {
  constructor(private readonly permissions: PermissionService) {}

  /**
   * 读授权视图。**全员可读** —— 读是开放的(§5.3 规则一),
   * 而且"谁能改这篇"本身就是该让所有人看到的信息。
   */
  @Get('nodes/:nodeId/grants')
  overview(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeGrantsResponse> {
    return this.permissions.overview(user, nodeId);
  }

  /**
   * 可授权的候选人 —— 服务端**已按操作者组织范围过滤**。
   *
   * 前端拿它填选择器。这不是安全边界:写入时会逐个再校验
   * (见 `replaceGrants`),否则改一下请求体就能越权。
   */
  @Get('nodes/:nodeId/grant-candidates')
  candidates(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<GrantCandidate[]> {
    return this.permissions.candidates(user, nodeId);
  }

  /** 整表替换名单。 */
  @Put('nodes/:nodeId/grants')
  save(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SaveGrantsDto,
  ): Promise<NodeGrantsResponse> {
    return this.permissions.replaceGrants(user, nodeId, body);
  }
}
