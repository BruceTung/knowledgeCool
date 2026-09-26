import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthUser, GrantCandidate, OrgScopeOption, OrgUserView } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import {
  CreateOrgNodeDto,
  CreateUserDto,
  SetAssignmentsDto,
  SetOwnerDto,
  UpdateUserDto,
} from './dto/org.dto.js';
import { OrgService } from './org.service.js';

/**
 * 组织架构与人员(DESIGN.md §6.2 的「组织架构」一组)。
 *
 * 权限与职责边界:
 *   - **建部门 / 人员维护 / 设归属** → 超管(组织架构是管理层的事)
 *   - **建组 / 任命组长** → 该部门的祖先所有者(即部长),见 `OrgService`
 *
 * ⚠️ 这里没有"邀请成员" —— 人是**预置**的,不是邀请进来的(§1.5)。
 * 也没有"空间成员角色" —— 新模型里没有角色,只有所有者/祖先链/显式授权。
 */
@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  /**
   * 组织范围下拉数据(一级 + 二级节点的路径与人数)。
   * 给「设置归属」与「建组」两个界面共用。
   */
  @Get('org/scopes')
  scopes(): Promise<OrgScopeOption[]> {
    return this.org.scopeOptions();
  }

  /** 建部门(一级节点,仅超管)或建组(二级节点,部长)。 */
  @Post('org/nodes')
  @HttpCode(HttpStatus.CREATED)
  createNode(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateOrgNodeDto,
  ): Promise<{ id: string; title: string }> {
    return this.org.createOrgNode(user, body);
  }

  /** 能担任该节点所有者的人选(已按操作者组织范围过滤)。 */
  @Get('nodes/:nodeId/owner-candidates')
  ownerCandidates(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<GrantCandidate[]> {
    return this.org.ownerCandidates(user, nodeId);
  }

  /**
   * 任命 / 变更所有者 —— 部长任命组长走这条。
   *
   * 一级节点(部门)改所有者只有超管能做:否则部长可以把自己改成任何人,
   * 等于自授权力。这条限制在 service 里。
   */
  @Patch('nodes/:nodeId/owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  setOwner(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SetOwnerDto,
  ): Promise<void> {
    return this.org.setOwner(user, nodeId, body.ownerId);
  }

  // ---------------- 人员(超管) ----------------

  @Get('admin/users')
  listUsers(@Query('q') q?: string): Promise<OrgUserView[]> {
    return this.org.listUsers(q);
  }

  @Post('admin/users')
  @HttpCode(HttpStatus.CREATED)
  createUser(@CurrentUser() user: AuthUser, @Body() body: CreateUserDto): Promise<OrgUserView> {
    return this.org.createUser(user, body);
  }

  @Patch('admin/users/:userId')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateUserDto,
  ): Promise<OrgUserView> {
    return this.org.updateUser(user, userId, body);
  }

  @Patch('admin/users/:userId/assignments')
  setAssignments(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: SetAssignmentsDto,
  ): Promise<OrgUserView> {
    return this.org.setAssignments(user, userId, body);
  }
}
