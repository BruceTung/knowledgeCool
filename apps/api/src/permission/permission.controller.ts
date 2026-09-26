import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import type {
  AuthUser,
  PagePermissionsResponse,
  PermissionSubjectCandidate,
} from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SavePermissionsDto } from './dto/save-permissions.dto.js';
import { PermissionService } from './permission.service.js';

/**
 * 页面权限接口(DESIGN.md §6.2)。
 *
 * 授权全部下沉到 PermissionService ——
 * 这里**不做任何权限判断**,包括"读权限也要登录"这件事都由全局 AuthGuard 保证。
 */
@Controller()
export class PermissionController {
  constructor(private readonly permissions: PermissionService) {}

  /** 读本页显式规则 + 从根到自身的推导链。 */
  @Get('pages/:pageId/permissions')
  @HttpCode(HttpStatus.OK)
  overview(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<PagePermissionsResponse> {
    return this.permissions.overview(user, pageId);
  }

  /** 整表替换本页的显式规则。需要空间管理员权限。 */
  @Put('pages/:pageId/permissions')
  @HttpCode(HttpStatus.OK)
  replace(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: SavePermissionsDto,
  ): Promise<PagePermissionsResponse> {
    return this.permissions.replaceRules(user, pageId, dto);
  }

  /** 权限弹窗的候选主体:空间成员 + 部门。 */
  @Get('spaces/:spaceId/permission-candidates')
  @HttpCode(HttpStatus.OK)
  candidates(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<PermissionSubjectCandidate[]> {
    return this.permissions.candidates(user, spaceId);
  }
}
