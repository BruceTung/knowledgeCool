import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  AuthUser,
  GrantCandidate,
  NodeMembersResponse,
  OrgImportResponse,
  OrgScopeOption,
  OrgUserListResponse,
  OrgUserView,
} from '@knowledgecool/shared';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import {
  AddNodeMemberDto,
  CreateOrgNodeDto,
  CreateUserDto,
  SetAssignmentsDto,
  SetOwnerDto,
  UpdateUserDto,
} from './dto/org.dto.js';
import { OrgImportService } from './import.service.js';
import { OrgService } from './org.service.js';

/** Excel 上传上限。全公司几百人的名单撑死几百 KB,给 8MB 已经很宽。 */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/**
 * 组织架构与人员(DESIGN.md §6.2 的「组织架构」一组)。
 *
 * 权限与职责边界:
 *   - **建部门 / 人员维护 / 设归属** → 超管(组织架构是管理层的事)
 *   - **建组 / 任命组长** → 该部门的祖先所有者(即部长),见 `OrgService`
 *
 * ⚠️ 这里没有"邀请成员" —— 人是**预置**的,不是邀请进来的(§1.2)。
 * 也没有"空间成员角色" —— 新模型里没有角色,只有所有者/祖先链/显式授权。
 */
@Controller()
export class OrgController {
  constructor(
    private readonly org: OrgService,
    private readonly imports: OrgImportService,
  ) {}

  /**
   * 组织范围下拉数据(一级 + 二级节点的路径与人数)。
   * 给「设置归属」与「建组」两个界面共用。
   */
  @Get('org/scopes')
  scopes(@CurrentUser() user: AuthUser): Promise<OrgScopeOption[]> {
    return this.org.scopeOptions(user);
  }

  /** 建部门(一级节点,仅超管)或建组(二级节点,部长)。 */
  @Post('org/nodes')
  @HttpCode(HttpStatus.CREATED)
  createNode(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateOrgNodeDto,
  ): Promise<{ id: string; title: string }> {
    return this.org.createOrgNode(user, body);
  }

  /** 能担任该节点所有者的人选(已按操作者组织范围过滤)。 */
  @Get('nodes/:nodeId/owner-candidates')
  ownerCandidates(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<GrantCandidate[]> {
    return this.org.ownerCandidates(user, nodeId);
  }

  /**
   * 任命 / 变更所有者 —— 部长任命组长走这条。
   *
   * 一级节点(部门)改所有者只有超管能做:否则部长可以把自己改成任何人,
   * 等于自授权力。这条限制在 service 里。
   */
  @Patch('nodes/:nodeId/owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  setOwner(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: SetOwnerDto,
  ): Promise<void> {
    return this.org.setOwner(user, nodeId, body.ownerId);
  }

  // ---------------- 节点成员(v2.4) ----------------

  /**
   * 这个节点下都有谁。
   *
   * **默认读全员开放** —— 与整棵树一致(§5.3 规则一):组织架构本来就是公开的。
   * 写操作才需要 `canManage`,`canManage` 也在响应里给前端。
   *
   * ⚠️ 受限节点**除外**:服务端先过 `requireRead`,读不到一律 404。
   * (树从 v2.12 起做可见性过滤,这一组接口当时漏了收口 —— v2.16 补齐。)
   */
  @Get('nodes/:nodeId/members')
  members(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<NodeMembersResponse> {
    return this.org.members(user, nodeId);
  }

  /**
   * 能加到该节点下的人(已按操作者组织范围过滤)。
   *
   * ⚠️ 与授权候选人(`/nodes/:id/grant-candidates`)是**两条接口**,
   * 因为门槛不同:授权要求 `canManage`,成员维护对超管放行。见 `OrgService`。
   */
  @Get('nodes/:nodeId/member-candidates')
  memberCandidates(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<GrantCandidate[]> {
    return this.org.memberCandidates(user, nodeId);
  }

  /**
   * 把某人加到该节点下(**追加**一条归属,不是整表替换)。
   *
   * 返回 200 而不是 201:响应体是整个成员视图(前端直接用它刷新列表),
   * 而不是"新建出来的那个资源"。
   */
  @Post('nodes/:nodeId/members')
  @HttpCode(HttpStatus.OK)
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() body: AddNodeMemberDto,
  ): Promise<NodeMembersResponse> {
    return this.org.addMember(user, nodeId, body.userId);
  }

  /** 把某人从该节点**移出** —— 调岗两步里的第二步。 */
  @Delete('nodes/:nodeId/members/:userId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<NodeMembersResponse> {
    return this.org.removeMember(user, nodeId, userId);
  }

  // ---------------- 人员(超管) ----------------

  /**
   * 人员列表。**超管专属** —— 名册里含账号状态与登录时间,不是公开信息。
   *
   * 分页是游标式的(`cursor` = 上一页最后一行的工号),不是 offset:
   * 按工号排序时 offset 分页在有人新建账号后会跳过或重复记录。
   * `limit` 上限 500 —— 下拉选择器需要尽量全的名单,它没法翻页。
   */
  @Get('admin/users')
  listUsers(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<OrgUserListResponse> {
    const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.org.listUsers(
      user,
      q,
      cursor,
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @Post('admin/users')
  @HttpCode(HttpStatus.CREATED)
  createUser(@CurrentUser() user: AuthUser, @Body() body: CreateUserDto): Promise<OrgUserView> {
    return this.org.createUser(user, body);
  }

  @Patch('admin/users/:userId')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateUserDto,
  ): Promise<OrgUserView> {
    return this.org.updateUser(user, userId, body);
  }

  @Patch('admin/users/:userId/assignments')
  setAssignments(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: SetAssignmentsDto,
  ): Promise<OrgUserView> {
    return this.org.setAssignments(user, userId, body);
  }

  /**
   * 把某人的密码**重置为内置初始密码**,并强制他下次登录先改密。
   *
   * 这是「员工忘密码」的正规出口 —— 没有它,只能进容器改数据库。
   * 副作用是**会立刻吊销他全部会话**,所以界面上必须先确认再点。
   *
   * 返回 200 而不是 201:没有新建任何东西,响应体是那个人刷新后的视图。
   */
  @Post('admin/users/:userId/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<OrgUserView> {
    return this.org.resetPassword(user, userId);
  }

  // ---------------- 组织架构导入(Excel,§8.5) ----------------

  /**
   * 下载模板。**模板里带当前全部数据** —— 管理员的动作是"往上加行",
   * 而不是"从空白开始填"(见 §8.5 对"覆盖 vs 增量"的讨论)。
   */
  @Get('admin/org/import-template')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async importTemplate(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.imports.buildTemplate(user);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="org-import.xlsx"; filename*=UTF-8''${encodeURIComponent('组织架构导入模板.xlsx')}`,
    );
    res.end(buffer);
  }

  /**
   * 上传并**预览差异**,或确认写入。同一个接口的两个模式。
   *
   * 刻意做成一个接口而不是两个:`dryRun` 与写入**共用同一份解析与差异计算**。
   * 拆成两条路径的话,两边迟早算出不同结果,而管理员是照着预览做决定的。
   *
   * 确认写入时**必须带上预览返回的 `contentHash`** —— 不一致说明文件换过了。
   */
  @Post('admin/org/import')
  @UseInterceptors(
    FileInterceptor('file', {
      // 内存存储:Excel 只用来解析,不该在磁盘上留任何副本
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
    }),
  )
  import(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('dryRun') dryRun?: string,
    @Query('contentHash') contentHash?: string,
  ): Promise<OrgImportResponse> {
    // ⚠️ 权限检查必须在**文件校验之前**。
    //
    // 反过来的话,一个普通成员不带文件请求这个接口会先撞上"请选择文件"的 400 ——
    // 等于告诉了他"这个接口存在、只是你参数没给对"。权限不足就该一律 403,
    // 而且要在做任何其他判断之前。(这条是实跑验收时发现顺序错了才补的。)
    if (!user.isSuperAdmin) {
      throw AppError.forbidden('只有管理员能维护组织架构与人员');
    }
    if (file === undefined) {
      throw AppError.validation('请选择要上传的 .xlsx 文件(字段名 file)');
    }
    return this.imports.run(user, file.buffer, {
      dryRun: dryRun !== 'false',
      expectedHash: contentHash,
    });
  }
}
