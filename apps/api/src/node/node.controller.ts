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
import type {
  AuthUser,
  NodeContentResponse,
  NodeDetail,
  NodeTreeResponse,
  TrashItem,
  TrashPolicy,
  TrashPurgeResult,
} from '@knowledgecool/shared';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import { ContentService } from './content.service.js';
import { CreateNodeDto, MoveNodeDto, UpdateNodeDto } from './dto/node.dto.js';
import { SaveContentDto } from './dto/save-content.dto.js';
import { NodeService } from './node.service.js';
import { RetentionService } from './retention.service.js';

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
    private readonly retention: RetentionService,
  ) {}

  /**
   * 组织与内容树。**全员可读,不做权限过滤**(§5.3 规则一)。
   *
   * 响应里额外带 `editableNodeIds` / `manageableNodeIds`,前端据此**隐藏**按钮。
   * 那不是安全边界 —— 服务端每个写接口仍各自判定。
   *
   * `?root=<nodeId>` 只返回那棵子树(v2.4)。留这个口子是因为"全员开放读 +
   * 一棵大树"在公司到几千人时会很大 —— 但**不要把接口做成只能返回全部**,
   * 否则将来改成按需加载要动接口形状(§11.3)。根不存在或已删 → 404。
   */
  @Get('org/tree')
  tree(
    @CurrentUser() user: AuthUser,
    @Query('root', new ParseUUIDPipe({ optional: true })) root?: string,
  ): Promise<NodeTreeResponse> {
    return this.nodes.tree(user, root);
  }

  /**
   * 回收站保留策略(只读,登录即可)。
   *
   * ⚠️ 必须注册在 `trash` **之前**?—— 不必:两者是精确路径,`trash` 不会
   * 匹配 `trash/policy`。但放在前面读起来更顺(更具体的先写)。
   */
  @Get('trash/policy')
  trashPolicy(): TrashPolicy {
    return this.retention.policy();
  }

  /** 回收站:只列我 `canEdit` 的已删子树根。 */
  @Get('trash')
  trash(@CurrentUser() user: AuthUser): Promise<TrashItem[]> {
    return this.nodes.trash(user);
  }

  /**
   * 按保留策略清理回收站(v2.4)。**超管**。
   *
   * 平时由 `RetentionService` 定时自动跑;这条是给运维的显式入口 ——
   * 首次上线时清掉历史积压、或临时调整保留天数之后立刻生效。
   *
   * `?dryRun=true` 只列不删:一个会删数据的任务必须能先空跑一次。
   */
  @Post('admin/maintenance/trash-purge')
  @HttpCode(HttpStatus.OK)
  trashPurge(
    @CurrentUser() user: AuthUser,
    @Query('dryRun') dryRun?: string,
  ): Promise<TrashPurgeResult> {
    // ⚠️ 权限判断放在最前 —— 不要等解析完参数再说(§9.3 踩过:顺序错了
    // 会让"参数不对"的 400 先于 403 返回,等于确认了这个接口存在)。
    if (!user.isSuperAdmin) {
      throw AppError.forbidden('只有管理员能手动清理回收站');
    }
    return this.retention.run({ dryRun: dryRun === 'true' });
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
