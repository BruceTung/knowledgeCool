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
  Query,
} from '@nestjs/common';
import type { AuthUser, CommentListResponse, CommentView } from '@knowledgecool/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { CommentService } from './comment.service.js';
import { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto.js';

/**
 * 评论接口(DESIGN.md §6.2)。
 *
 * 路由形状:读取以**节点**为界(`/nodes/:id/comments`),修改以**评论**为界
 * (`/comments/:id`)。一条评论属于哪个节点由**服务端查出来**,
 * 不让客户端指定 —— 否则可以拿别人的评论 id 去打一个自己有权访问的节点。
 *
 * v2.0 变化:`/pages/:id/comments` → `/nodes/:id/comments`;
 * 角标从 `/spaces/:id/comment-counts` → `GET /comment-counts?ids=a,b,c`
 * (树现在一次返回全公司,角标跟着节点列表走,而不是跟着空间走)。
 */
@Controller()
export class CommentController {
  constructor(private readonly comments: CommentService) {}

  @Get('nodes/:nodeId/comments')
  @HttpCode(HttpStatus.OK)
  list(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<CommentListResponse> {
    return this.comments.list(user, nodeId);
  }

  @Post('nodes/:nodeId/comments')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: CreateCommentDto,
  ): Promise<CommentView> {
    return this.comments.create(user, nodeId, dto);
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

  /**
   * 一批节点的**评论总数** —— 节点树角标。
   *
   * 用查询串而不是路径参数,是因为调用方(树)手里**本来就有**这批 id,
   * 不必为了取角标再要求它按某个"空间"去分组。
   */
  @Get('comment-counts')
  @HttpCode(HttpStatus.OK)
  counts(@Query('ids') ids: string | undefined): Promise<Record<string, number>> {
    return this.comments.commentCounts(parseIdList(ids));
  }
}

/**
 * 解析 `?ids=a,b,c`。
 *
 * **按 UUID 形状过滤**而不是"原样透传再让数据库报错":一个畸形 id 会让
 * 整个 `in (...)` 查询抛 22P02(类型转换失败),连带把整棵树的角标都打没 ——
 * 而这不是用户能理解的错误。丢掉畸形项、返回其余的,才是合理的降级。
 */
function parseIdList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => UUID_PATTERN.test(segment));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
