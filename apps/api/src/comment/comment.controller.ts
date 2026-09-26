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
import type { AuthUser, CommentListResponse, CommentView } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { CommentService } from './comment.service.js';
import { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto.js';

/**
 * 评论接口(DESIGN.md §6.2 里的 4 条)。
 *
 * 注意路由形状:读取以**页面**为界(`/pages/:id/comments`),
 * 修改以**评论**为界(`/comments/:id`)—— 因为一条评论属于哪一页
 * 由服务端查出来,不能让客户端指定(否则可以拿别人的评论 id 去打自己有权访问的页面)。
 */
@Controller()
export class CommentController {
  constructor(private readonly comments: CommentService) {}

  @Get('pages/:pageId/comments')
  @HttpCode(HttpStatus.OK)
  list(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<CommentListResponse> {
    return this.comments.list(user, pageId);
  }

  @Post('pages/:pageId/comments')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: CreateCommentDto,
  ): Promise<CommentView> {
    return this.comments.create(user, pageId, dto);
  }

  @Patch('comments/:commentId')
  @HttpCode(HttpStatus.OK)
  update(
    @CurrentUser() user: AuthUser,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdateCommentDto,
  ): Promise<CommentView> {
    return this.comments.update(user, commentId, dto);
  }

  @Delete('comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ): Promise<void> {
    return this.comments.remove(user, commentId);
  }

  /** 空间内各页面的未解决评论数 —— 页面树角标。 */
  @Get('spaces/:spaceId/comment-counts')
  @HttpCode(HttpStatus.OK)
  counts(
    @CurrentUser() user: AuthUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<Record<string, number>> {
    return this.comments.openCounts(user, spaceId);
  }
}
