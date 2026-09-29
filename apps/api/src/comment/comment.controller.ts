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
 * 评论接口(DESIGN.md §6.2)。
 *
 * 路由形状:读取以**节点**为界(`/nodes/:id/comments`),修改以**评论**为界
 * (`/comments/:id`)。一条评论属于哪个节点由**服务端查出来**,
 * 不让客户端指定 —— 否则可以拿别人的评论 id 去打一个自己有权访问的节点。
 *
 * v2.0 变化:`/pages/:id/comments` → `/nodes/:id/comments`。
 *
 * ⚠️ v2.16:全局的 `GET /comment-counts` 已删除 —— 角标由 `/org/tree`
 * 随节点一起返回,那条接口既没有调用方、又没有权限判定(见下方的说明)。
 * 所以本文件的接口**全部以节点或评论为界**,没有任何"跨节点批量取数"的入口。
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

  /*
    ⚠️ v2.16 删掉了 `GET /comment-counts?ids=a,b,c`。

    它有两个问题,而且是同一个根:**它是 v2.0 的形状的遗留物。**

      1. **没有任何权限判定。** 它直接把任意 nodeId 的评论数返回给任何登录用户。
         对受限节点来说,这既确认了"这个节点存在",又交出了"它上面有多少条评论" ——
         而其余读取路径(详情 / 正文 / 导出 / 评论列表 / 成员)都回 404。
         一条不一致的路径就是一条侧信道(§5.6)。
      2. **它是死接口。** 角标早就不走它了:树在 `/org/tree` 里
         一并返回 `commentCount`(见 `NodeService.tree`),因为树本来就要
         为可见性过滤把节点查一遍,顺带 `groupBy` 一次比再发一轮请求便宜。
         全仓库(前端、脚本、文档)没有任何调用点。

    修法只有一种:**删掉它**。给它补上读判定也行,但那等于花代价维护一条
    没有调用方的接口 —— 而"没人调用但能被调用"的路径正是最容易漏掉守卫的地方。
  */
}
