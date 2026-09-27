import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type {
  AuthUser,
  GrantCandidate,
  NodeGrantsResponse,
  NodeReadersResponse,
  ReaderCandidate,
} from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SaveGrantsDto } from './dto/save-grants.dto.js';
import { SaveReadersDto } from './dto/save-readers.dto.js';
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
   * 读授权视图。
   *
   * v2.12 起**要先能读这个节点**。此前这里是"全员可读"(读对所有人开放),
   * 而有了受限节点之后那句话不再成立 —— 不过滤的话,一个受限节点的
   * 授权名单(谁在这个名单里、所有者是谁)会直接暴露给全公司,
   * 而"名单里都有谁"本身就够敏感了。
   */
  @Get('nodes/:nodeId/grants')
  async overview(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeGrantsResponse> {
    await this.permissions.requireRead(user, nodeId);
    return this.permissions.overview(user, nodeId);
  }

  /**
   * 可授权的候选人 —— 服务端**已按操作者组织范围过滤**。
   *
   * 前端拿它填选择器。这不是安全边界:写入时会逐个再校验
   * (见 `replaceGrants`),否则改一下请求体就能越权。
   */
  @Get('nodes/:nodeId/grant-candidates')
  async candidates(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<GrantCandidate[]> {
    // 同上:候选人名单会泄露"这个节点归谁管、组织范围多大"
    await this.permissions.requireRead(user, nodeId);
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

  // ================================================================
  // 可见性与读者名单(v2.12)
  // ================================================================

  /**
   * 读可见性 + 读者名单。
   *
   * ⚠️ 这里**不要求 canManage** —— 能读这个节点的人都可以看"还有谁能看它"。
   * 那是与授权视图同一条理由:透明比隐藏更有用,而且名单本身不含内容。
   */
  @Get('nodes/:nodeId/readers')
  readers(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeReadersResponse> {
    return this.permissions.readersOverview(user, nodeId);
  }

  /**
   * 候选读者 —— **不限组织范围**。
   *
   * 授权候选人要卡组织范围(防横向越权),读者候选**刻意不卡**:
   * 受限节点的读者常常就是本部门之外的人,否则"保密"没有意义。
   * 这是取舍,不是漏写。
   */
  @Get('nodes/:nodeId/reader-candidates')
  readerCandidates(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<ReaderCandidate[]> {
    return this.permissions.readerCandidates(user, nodeId);
  }

  /** 整表替换可见性与读者名单。门槛是创建者或所有者链。 */
  @Put('nodes/:nodeId/readers')
  saveReaders(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SaveReadersDto,
  ): Promise<NodeReadersResponse> {
    return this.permissions.replaceReaders(user, nodeId, body);
  }
}
