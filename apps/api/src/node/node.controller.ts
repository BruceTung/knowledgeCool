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
  Res,
} from '@nestjs/common';
import type {
  AuthUser,
  NodeContentResponse,
  NodeDetail,
  NodeTreeResponse,
  TrashItem,
} from '@knowledgecool/shared';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ContentService } from './content.service.js';
import { CreateNodeDto, MoveNodeDto, UpdateNodeDto } from './dto/node.dto.js';
import { SaveContentDto } from './dto/save-content.dto.js';
import { NodeService } from './node.service.js';

/**
 * 节点接口(空间与页面合并后的统一资源)。
 *
 * v2.0 的三处路由变化:
 *   - `/spaces/:id/pages`(整树) → **`/org/tree`**(全公司一棵树,不再按空间分)
 *   - `/pages/:id` → `/nodes/:id`
 *   - `/spaces/:id/trash` → **`/trash`**(回收站列"我所有能改的",天然跨部门)
 *
 * ⚠️ `GET trash` 必须注册在 `nodes/:nodeId` **之前**?—— 不必,路径前缀不同
 * (`trash` vs `nodes/...`),不会撞。但 `nodes/:nodeId` 与 `nodes/:nodeId/content`
 * 的先后是有意义的:Nest 按注册顺序匹配,更具体的路径要放前面。
 */
@Controller()
export class NodeController {
  constructor(
    private readonly nodes: NodeService,
    private readonly contents: ContentService,
  ) {}

  /**
   * 整棵组织与内容树。**全员可读,不做权限过滤**(§5.3 规则一)。
   *
   * 响应里额外带 `editableNodeIds` / `manageableNodeIds`,前端据此**隐藏**按钮。
   * 那不是安全边界 —— 服务端每个写接口仍各自判定。
   */
  @Get('org/tree')
  tree(@CurrentUser() user: AuthUser): Promise<NodeTreeResponse> {
    return this.nodes.tree(user);
  }

  /** 回收站:只列我 `canEdit` 的已删子树根。 */
  @Get('trash')
  trash(@CurrentUser() user: AuthUser): Promise<TrashItem[]> {
    return this.nodes.trash(user);
  }

  @Post('nodes')
  create(@CurrentUser() user: AuthUser, @Body() body: CreateNodeDto): Promise<NodeDetail> {
    return this.nodes.create(user, body);
  }

  @Get('nodes/:nodeId/content')
  getContent(@Param('nodeId', ParseUUIDPipe) nodeId: string): Promise<NodeContentResponse> {
    return this.contents.get(nodeId);
  }

  @Put('nodes/:nodeId/content')
  saveContent(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SaveContentDto,
  ): Promise<NodeContentResponse> {
    return this.contents.save(user, nodeId, body);
  }

  /** 导出 Markdown。以 `text/markdown` 直接下载,不经 JSON 包装。 */
  @Get('nodes/:nodeId/export')
  async exportMarkdown(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.contents.exportMarkdown(nodeId);
    // 中文标题要走 RFC 5987 的 filename*,否则下载下来是乱码文件名
    const filename = encodeURIComponent(`${result.title}.md`);
    res
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
      .send(result.markdown);
  }

  @Get('nodes/:nodeId')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeDetail> {
    return this.nodes.detail(user, nodeId);
  }

  @Patch('nodes/:nodeId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: UpdateNodeDto,
  ): Promise<NodeDetail> {
    return this.nodes.update(user, nodeId, body);
  }

  /** 拖拽排序与改父级是同一个操作。 */
  @Post('nodes/:nodeId/move')
  move(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: MoveNodeDto,
  ): Promise<NodeDetail> {
    return this.nodes.move(user, nodeId, body);
  }

  /** 软删除:整棵子树进回收站。 */
  @Delete('nodes/:nodeId')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<{ removedCount: number }> {
    return this.nodes.remove(user, nodeId);
  }

  @Post('nodes/:nodeId/restore')
  restore(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeDetail> {
    return this.nodes.restore(user, nodeId);
  }

  /**
   * 彻底删除。**不可逆**,且只允许作用于回收站里的节点。
   *
   * 门槛是 `canManage`(祖先链所有者)而非 `canEdit` ——
   * 被授权者能改能软删(可恢复),但不能彻底销毁(§5.4)。
   */
  @Delete('nodes/:nodeId/purge')
  @HttpCode(HttpStatus.NO_CONTENT)
  purge(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<void> {
    return this.nodes.purge(user, nodeId);
  }
}
