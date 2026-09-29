import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  EXPORT_FORMATS,
  type AuthUser,
  type NodeContentResponse,
  type NodeDetail,
  type NodeTreeResponse,
  isExportFormat,
  type BulkMoveResult,
} from '@knowledgecool/shared';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import { ContentService } from './content.service.js';
import { BulkMoveDto } from './dto/bulk-move.dto.js';
import { CreateNodeDto, MoveNodeDto, UpdateNodeDto } from './dto/node.dto.js';
import { SaveContentDto } from './dto/save-content.dto.js';
import { NodeService } from './node.service.js';

/**
 * 节点接口(空间与页面合并后的统一资源)。
 *
 * v2.0 的三处路由变化:
 *   - `/spaces/:id/pages`(整树) → **`/org/tree`**(全公司一棵树,不再按空间分)
 *   - `/pages/:id` → `/nodes/:id`
 *
 * ⚠️ `nodes/:nodeId` 与 `nodes/:nodeId/content` 的先后是有意义的:
 * Nest 按注册顺序匹配,更具体的路径要放前面。
 *
 * ⚠️ v2.12 起回收站整体移除:没有 `GET /trash`、`GET /trash/policy`、
 * `POST /admin/maintenance/trash-purge`、`POST /nodes/:id/restore`、
 * `DELETE /nodes/:id/purge`。`DELETE /nodes/:id` 现在是**物理删除**。
 */
@Controller()
export class NodeController {
  constructor(
    private readonly nodes: NodeService,
    private readonly contents: ContentService,
  ) {}

  /**
   * 组织与内容树。**全员可读,不做权限过滤**(§5.3 规则一)。
   *
   * 响应里额外带 `editableNodeIds` / `manageableNodeIds`,前端据此**隐藏**按钮。
   * 那不是安全边界 —— 服务端每个写接口仍各自判定。
   *
   * `?root=<nodeId>` 只返回那棵子树(v2.4)。留这个口子是因为"全员开放读 +
   * 一棵大树"在公司到几千人时会很大 —— 但**不要把接口做成只能返回全部**,
   * 否则将来改成按需加载要动接口形状(§11.3)。根不存在 → 404。
   */
  @Get('org/tree')
  tree(
    @CurrentUser() user: AuthUser,
    @Query('root', new ParseUUIDPipe({ optional: true })) root?: string,
  ): Promise<NodeTreeResponse> {
    return this.nodes.tree(user, root);
  }

  @Post('nodes')
  create(@CurrentUser() user: AuthUser, @Body() body: CreateNodeDto): Promise<NodeDetail> {
    return this.nodes.create(user, body);
  }

  @Get('nodes/:nodeId/content')
  getContent(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeContentResponse> {
    return this.contents.get(user, nodeId);
  }

  @Put('nodes/:nodeId/content')
  saveContent(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SaveContentDto,
  ): Promise<NodeContentResponse> {
    return this.contents.save(user, nodeId, body);
  }

  /**
   * 保存正文的 **POST 别名** —— 只为 `navigator.sendBeacon` 存在(§7.5)。
   *
   * ⚠️ 这条路由不是"顺手多开一个入口",是**必须的**:
   * `navigator.sendBeacon` **只能发 POST**,而正文原本只有 PUT。
   * 于是关标签页时那次兜底保存会打到一条不存在的路由上,
   * 被丢掉的是一个 404 —— 而页面已经在卸载,没有任何地方会看到它。
   *
   * 这正是 §7.5 那个 P0 事故的第二半:卸载清理函数确实补了保存,
   * 但"关标签页"那条路(beacon)从来没送达过,而它看起来是送达的。
   * 表现是"停笔 1.2 秒内关掉标签页,打的字没了",与没加 beacon 时一模一样。
   *
   * 与 PUT 走**同一个 service 方法、同一份校验、同一套乐观锁** ——
   * 两个入口只差一个 HTTP 方法,不允许有任何行为差异。
   */
  @Post('nodes/:nodeId/content')
  saveContentByBeacon(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SaveContentDto,
  ): Promise<NodeContentResponse> {
    return this.contents.save(user, nodeId, body);
  }

  /**
   * 导出。以 `text/markdown` 直接下载,不经 JSON 包装。
   *
   * `?format=` 只支持 `md`(省略也行);**其它值一律 400**。
   * v2.12 之前这个参数被完全忽略:传 `?format=pdf` 会静默返回一份 Markdown,
   * 调用方以为拿到了 PDF。**契约里写了参数却不去读它,比没有这个参数更坏。**
   *
   * PDF 的路线已经定了:**前端打印样式 + `window.print()`**,不在服务端渲染 ——
   * 无头 Chrome 会给镜像加 300~400MB,与构建机的内存上限冲突(见 DESIGN §2.1)。
   */
  @Get('nodes/:nodeId/export')
  async exportMarkdown(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (format !== undefined && !isExportFormat(format)) {
      throw AppError.validation(
        `暂不支持导出为 ${format},目前只支持 ${EXPORT_FORMATS.join(' / ')}`,
      );
    }

    const result = await this.contents.exportMarkdown(user, nodeId);
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

  /**
   * 批量移动(v2.14)。
   *
   * ⚠️ 路径是 `nodes/bulk/move` 而**不是** `nodes/bulk-move`,而且必须注册在
   * `nodes/:nodeId/...` **之前**:Express 按注册顺序匹配,`bulk` 会被当成一个 nodeId,
   * 然后被 ParseUUIDPipe 以 400 拒掉 —— 表现是这条接口"不管怎么调都说参数不对"。
   *
   * ⚠️ 只做移动,不做批量删除。移动可逆,删除不可恢复 ——
   * 两者的风险差一个量级,不该共用一个入口。
   */
  @Post('nodes/bulk/move')
  bulkMove(
    @CurrentUser() user: AuthUser,
    @Body() body: BulkMoveDto,
  ): Promise<BulkMoveResult> {
    return this.nodes.bulkMove(user, body);
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

  /**
   * 删除节点 —— **整棵子树物理删除,不可恢复**(v2.12)。
   *
   * 门槛是 `canManage`(该节点或祖先链的所有者)而非 `canEdit` ——
   * 被授权者能改,但不能销毁。删除不可逆之后,这条边界必须守住。
   */
  @Delete('nodes/:nodeId')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<{ removedCount: number }> {
    return this.nodes.remove(user, nodeId);
  }
}
