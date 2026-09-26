import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import type {
  AuthUser,
  SpaceMemberView,
  SpaceMembersResponse,
  SpaceSummary,
} from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { AddSpaceMemberDto } from './dto/add-space-member.dto.js';
import { CreateSpaceDto } from './dto/create-space.dto.js';
import { UpdateSpaceMemberRoleDto } from './dto/update-space-member-role.dto.js';
import { SpaceService } from './space.service.js';

/**
 * 空间与成员接口(DESIGN.md §6.2)。
 *
 * 实际路径带全局前缀: /api/v1/spaces/...
 *
 * 这里**没有任何权限判断** —— 全部下沉到 SpaceService。
 * controller 只负责:取当前用户、把 DTO 交给 service、把结果返回。
 * 权限逻辑放一处才能被单测整体覆盖(DESIGN.md §12 把权限判定列为
 * "错了不会立刻报错"的三类高危逻辑之一)。
 */
@Controller('spaces')
export class SpaceController {
  constructor(private readonly spaces: SpaceService) {}

  /** 我可见的空间列表。 */
  @Get()
  @HttpCode(HttpStatus.OK)
  list(@CurrentUser() user: AuthUser): Promise<SpaceSummary[]> {
    return this.spaces.listForUser(user);
  }

  /** 新建空间,创建者成为所有者 + 空间管理员。 */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSpaceDto): Promise<SpaceSummary> {
    return this.spaces.create(user, dto);
  }

  /**
   * 成员列表。
   *
   * `ParseUUIDPipe` 让畸形 id 在进库前就变成 400,而不是靠 Postgres
   * 抛一个 uuid 语法错误再被收敛成 500 —— 后者会把内部结构暴露到日志里。
   */
  @Get(':spaceId/members')
  @HttpCode(HttpStatus.OK)
  members(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<SpaceMembersResponse> {
    return this.spaces.listMembers(user, spaceId);
  }

  /** 邀请成员 / 建号后加入。需要空间管理员。 */
  @Post(':spaceId/members')
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: AddSpaceMemberDto,
  ): Promise<SpaceMemberView> {
    return this.spaces.addMember(user, spaceId, dto);
  }

  /** 修改成员角色。需要空间管理员。 */
  @Patch(':spaceId/members/:userId')
  @HttpCode(HttpStatus.OK)
  updateMemberRole(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSpaceMemberRoleDto,
  ): Promise<SpaceMemberView> {
    return this.spaces.updateMemberRole(user, spaceId, userId, dto.role);
  }

  /** 移除成员。需要空间管理员。 */
  @Delete(':spaceId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.spaces.removeMember(user, spaceId, userId);
  }
}
