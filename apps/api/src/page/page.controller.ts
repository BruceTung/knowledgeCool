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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  AuthUser,
  PageContentResponse,
  PageDetail,
  PageTreeResponse,
  TrashItem,
} from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SaveContentDto } from './dto/save-content.dto.js';
import { ContentService } from './content.service.js';
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
  constructor(
    private readonly pages: PageService,
    private readonly content: ContentService,
  ) {}

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

  // ----------------------------------------------------------------
  // 正文(§7.4 的文档模型)
  // ----------------------------------------------------------------

  /**
   * 取正文。
   *
   * 页面刚建出来时还没有正文行 —— 那不是错误,服务端返回空文档,
   * 前端拿到的永远是合法可渲染的结构。
   */
  @Get('pages/:pageId/content')
  @HttpCode(HttpStatus.OK)
  getContent(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<PageContentResponse> {
    return this.content.get(user, pageId);
  }

  /** 存正文。同步重算 `text_for_search`;`baseUpdatedAt` 不匹配返回 409。 */
  @Put('pages/:pageId/content')
  @HttpCode(HttpStatus.OK)
  saveContent(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: SaveContentDto,
  ): Promise<PageContentResponse> {
    return this.content.save(user, pageId, dto);
  }

  /**
   * 导出为 Markdown(M6)。
   *
   * 走 `Accept` 协商不合适 —— 同一个 URL 返回两种内容类型会让缓存与调试都变难。
   * 这里用显式的 `?format=md`,并直接以 `text/markdown` 返回,方便浏览器直接下载。
   */
  @Get('pages/:pageId/export')
  async export(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    // format 目前只有 md 一种;保留参数是为了将来加 pdf/png 时不改路由
    @Query('format') _format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.content.exportMarkdown(user, pageId);
    // 文件名里可能有 `/`、`:` 之类会破坏 Content-Disposition 的字符
    const safeName = result.title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) || 'page';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.md`)}`,
    );
    res.send(result.markdown);
  }
}
