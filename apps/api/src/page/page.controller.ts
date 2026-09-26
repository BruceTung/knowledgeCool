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
import type { AuthUser, PageDetail, PageTreeResponse, TrashItem } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { CreatePageDto, MovePageDto, UpdatePageDto } from './dto/page.dto.js';
import { PageService } from './page.service.js';

/**
 * 页面接口(DESIGN.md §6.2)。
 *
 * 路径有两种前缀,所以用空 `@Controller()`:树的读取天然以空间为界
 * (`/spaces/:spaceId/pages`),而单页操作以页面 id 为界(`/pages/:pageId`)。
 * 硬拆成两个 controller 反而会把同一份鉴权逻辑讲两遍。
 *
 * 与 SpaceController 一样:这里**不做任何权限判断**,全部下沉到 PageService。
 */
@Controller()
export class PageController {
  constructor(private readonly pages: PageService) {}

  /** 整棵页面树(不含回收站)。 */
  @Get('spaces/:spaceId/pages')
  @HttpCode(HttpStatus.OK)
  tree(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<PageTreeResponse> {
    return this.pages.tree(user, spaceId);
  }

  /** 空间回收站。 */
  @Get('spaces/:spaceId/trash')
  @HttpCode(HttpStatus.OK)
  trash(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<TrashItem[]> {
    return this.pages.trash(user, spaceId);
  }

  @Post('pages')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePageDto): Promise<PageDetail> {
    return this.pages.create(user, dto);
  }

  @Get('pages/:pageId')
  @HttpCode(HttpStatus.OK)
  detail(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<PageDetail> {
    return this.pages.detail(user, pageId);
  }

  /** 改名 / 改状态,带乐观锁(version 不匹配返回 409)。 */
  @Patch('pages/:pageId')
  @HttpCode(HttpStatus.OK)
  update(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: UpdatePageDto,
  ): Promise<PageDetail> {
    return this.pages.update(user, pageId, dto);
  }

  /** 移动(拖拽排序与改父级是同一个操作)。服务端会递归重建整棵子树的路径。 */
  @Post('pages/:pageId/move')
  @HttpCode(HttpStatus.OK)
  move(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: MovePageDto,
  ): Promise<PageDetail> {
    return this.pages.move(user, pageId, dto);
  }

  /** 软删除,整棵子树一起进回收站。 */
  @Delete('pages/:pageId')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<{ removedCount: number }> {
    return this.pages.remove(user, pageId);
  }

  /** 从回收站恢复(整棵子树)。原父已不在树上时挂回空间根下。 */
  @Post('pages/:pageId/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<PageDetail> {
    return this.pages.restore(user, pageId);
  }

  /** 彻底删除。**不可逆**,且只允许作用于回收站里的页面。需要空间管理员。 */
  @Delete('pages/:pageId/purge')
  @HttpCode(HttpStatus.NO_CONTENT)
  purge(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<void> {
    return this.pages.purge(user, pageId);
  }
}
