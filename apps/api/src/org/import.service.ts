/**
 * 组织架构导入 —— IO 层。对应 DESIGN.md §8.4。
 *
 * 这里只做三件事:**生成模板、读 xlsx、执行计划**。
 * 解析、校验、差异计算全在 `import.core.ts`(纯函数,可单测)——
 * 那部分才是"错了会静默越权"的高危逻辑,不能和 IO 混在一起。
 *
 * 两个接口形态:
 *   `GET  /admin/org/import-template`  → xlsx 二进制
 *   `POST /admin/org/import?dryRun=…`  → 同一个接口两个模式,**共用同一份解析逻辑**
 *
 * 用 `contentHash` 把两个阶段绑在一起:确认写入时带上预览拿到的那份哈希,
 * 不一致就 409。没有这道校验的话,管理员在预览后又改了一版表格再上传,
 * 写入的就是他没看过的那一份 —— 而他会以为看过。
 */

import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  INITIAL_PASSWORD,
  type Actor,
  type OrgImportResponse,
  type OrgImportResult,
} from '@knowledgecool/shared';
import ExcelJS from 'exceljs';

import { recordAudit } from '../audit/record.js';
import { PasswordService } from '../auth/password.service.js';
import { AppError } from '../common/errors/app-error.js';
import { pathOfChild, pathOfRoot, renderPath } from '../common/node-path.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IMPORT_COLUMNS,
  IMPORT_HELP_SHEET_NAME,
  IMPORT_SHEET_NAME,
  type CurrentState,
  type ImportPlan,
  type NodeRef,
  type RowIssue,
  type UserRef,
  parseRows,
  planImport,
  type RawRow,
} from './import.core.js';
import { OrgService } from './org.service.js';

/** 单次导入的行数上限。防的是"上传了一个几十万行的表把内存打爆"。 */
const MAX_IMPORT_ROWS = 20_000;

/** 未归属人员那张附加表的表名。 */
const UNLISTED_SHEET_NAME = '未列入的人员';

@Injectable()
export class OrgImportService {
  private readonly logger = new Logger(OrgImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrgService,
    private readonly passwords: PasswordService,
  ) {}

  // ================================================================
  // 模板
  // ================================================================

  /**
   * 生成模板。
   *
   * **模板里带当前全部数据** —— 这一点很要紧:管理员拿到的是"几百人已经在里面"
   * 的表,他的动作是"往上加行",而不是"从空白开始填"。
   * 后者必然有人只填新增的几行就上传(见 §8.4 对"覆盖 vs 增量"的讨论)。
   *
   * 一行 = 一个人在一个节点上的归属;同一个人多行就是多归属。
   */
  async buildTemplate(operator: Actor): Promise<Buffer> {
    this.requireSuperAdmin(operator);

    const [nodes, users, assignments] = await Promise.all([
      this.prisma.node.findMany({
        select: {
          id: true,
          title: true,
          parentId: true,
          depth: true,
          position: true,
          materializedPath: true,
          ownerId: true,
        },
      }),
      this.prisma.user.findMany({
        select: { id: true, employeeNo: true, name: true, status: true },
      }),
      this.prisma.orgAssignment.findMany({ select: { userId: true, nodeId: true } }),
    ]);

    // 排放顺序:部门按 position,组按「父的 position + 自己的 position」。
    // 不排的话模板里的部门顺序是随机的(uuid 排序),管理员每次下载都对不上。
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const orderOf = (node: { id: string; parentId: string | null; position: number }): string => {
      const parent = node.parentId === null ? null : nodeById.get(node.parentId);
      return `${String(parent?.position ?? -1).padStart(6, '0')}-${String(node.position).padStart(6, '0')}`;
    };
    const orgNodes = nodes
      .filter((node) => node.depth <= 1)
      .sort((a, b) =>
        a.depth === b.depth ? orderOf(a).localeCompare(orderOf(b)) : a.depth - b.depth,
      );

    const titles = new Map(nodes.map((node) => [node.id, node.title]));
    const userById = new Map(users.map((user) => [user.id, user]));

    /** 节点 id → 该节点下的人(按工号排)。 */
    const membersOf = new Map<string, string[]>();
    for (const assignment of assignments) {
      const list = membersOf.get(assignment.nodeId) ?? [];
      list.push(assignment.userId);
      membersOf.set(assignment.nodeId, list);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '知源 KnowledgeCool';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(IMPORT_SHEET_NAME);
    sheet.columns = IMPORT_COLUMNS.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width,
    }));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const listedUserIds = new Set<string>();
    let dataRowCount = 0;

    for (const node of orgNodes) {
      const department = node.depth === 0 ? node : (nodeById.get(node.parentId ?? '') ?? null);
      const memberIds = (membersOf.get(node.id) ?? []).sort((a, b) => {
        const left = userById.get(a)?.employeeNo ?? '';
        const right = userById.get(b)?.employeeNo ?? '';
        return left.localeCompare(right);
      });

      for (const userId of memberIds) {
        const user = userById.get(userId);
        if (user === undefined) continue;
        listedUserIds.add(user.id);
        sheet.addRow({
          employeeNo: user.employeeNo,
          name: user.name,
          department: department?.title ?? node.title,
          group: node.depth === 0 ? null : node.title,
          isOwner: node.ownerId === userId ? '是' : null,
          departmentId: department?.id ?? node.id,
          groupId: node.depth === 0 ? null : node.id,
        });
        dataRowCount += 1;
      }
    }

    // 表头样式:加粗 + 灰底。ID 两列用浅灰字,视觉上提示"别动"。
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.eachCell((cell, index) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      if (index >= IMPORT_COLUMNS.length - 1) cell.font = { color: { argb: 'FF94A3B8' } };
    });

    // ---- 附加表:没被列出来的人与归属,免得管理员以为"系统里就这些人" ----
    const unlisted = workbook.addWorksheet(UNLISTED_SHEET_NAME);
    unlisted.columns = [
      { header: '工号', key: 'employeeNo', width: 18 },
      { header: '姓名', key: 'name', width: 14 },
      { header: '说明', key: 'reason', width: 60 },
    ];
    unlisted.getRow(1).font = { bold: true };

    for (const user of users) {
      if (listedUserIds.has(user.id)) continue;
      if (user.status !== 'active') continue; // 离职 / 停用的不进表,避免又把他们加回来
      unlisted.addRow({
        employeeNo: user.employeeNo,
        name: user.name,
        reason: '当前没有任何组织归属;若要给他归属,请在「人员名单」里补一行',
      });
    }
    for (const assignment of assignments) {
      const node = nodeById.get(assignment.nodeId);
      if (node === undefined) continue;
      if (node.depth <= 1) continue;
      const user = userById.get(assignment.userId);
      if (user === undefined) continue;
      unlisted.addRow({
        employeeNo: user.employeeNo,
        name: user.name,
        reason: `归属在三级及更深的节点「${renderPath(node.materializedPath, titles)}」上,本表只能表达部门与组,这一条不会被导入覆盖`,
      });
    }

    // ---- 填写说明 ----
    const help = workbook.addWorksheet(IMPORT_HELP_SHEET_NAME);
    help.columns = [
      { header: '列', key: 'column', width: 18 },
      { header: '怎么填', key: 'how', width: 90 },
    ];
    help.getRow(1).font = { bold: true };
    for (const line of HELP_LINES) help.addRow(line);

    if (dataRowCount === 0) {
      // 空库:给一行示例,否则管理员看着空表不知道格式
      sheet.addRow({
        employeeNo: 'KC2026001',
        name: '示例·张三',
        department: '技术部',
        group: '后端组',
        isOwner: '是',
        departmentId: null,
        groupId: null,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ================================================================
  // 上传(预览 / 写入共用)
  // ================================================================

  /**
   * @param dryRun `true` 只算差异不写库
   * @param expectedHash 确认写入时必带 —— 与本次解析出的哈希不一致则 409
   */
  async run(
    operator: Actor,
    file: Buffer,
    options: { dryRun: boolean; expectedHash?: string | undefined },
  ): Promise<OrgImportResponse> {
    this.requireSuperAdmin(operator);

    const contentHash = createHash('sha256').update(file).digest('hex');

    // ⚠️ 两道都要,**先要求必须带**,再比对。
    //
    // 原来只比对"带了但不一致"的情况:于是 `?dryRun=false` **不带** contentHash 时,
    // 整段校验被跳过 —— 预览与确认之间上传的文件被换掉,也不会有任何人发现。
    // 而 JSDoc 上面写着"确认写入时必带"、文档也这么写:**代码没有兑现自己声明的前提**,
    // 而"声明了却没检查"比没声明更危险(读的人会以为这道闸在)。
    // 仓库里三处写入调用点都已经带上它(`seed-dev.mjs` / `verify-org.mjs` / 前端导入向导)。
    if (!options.dryRun && options.expectedHash === undefined) {
      throw AppError.validation(
        '确认写入必须带上预览返回的 contentHash —— 它是「我确认的就是刚才预览的那一份」的凭据',
      );
    }
    if (!options.dryRun && options.expectedHash !== contentHash) {
      throw AppError.versionConflict('上传的文件与预览时的那一份不一致,请重新预览后再确认');
    }

    const raw = await this.readRows(file);
    const parsed = parseRows(raw);

    const response: OrgImportResponse = {
      contentHash,
      preview: {
        newUsers: [],
        renamedUsers: [],
        newAssignments: [],
        newNodes: [],
        renamedNodes: [],
        ownerChanges: [],
        ignoredRows: parsed.ignored,
        errors: parsed.errors,
      },
      applied: null,
    };

    // 行级问题存在时**不往下走**:差异是给"确认写入"看的,
    // 而这时候压根不允许写入,继续算只会给出一份误导性的预览。
    if (parsed.errors.length > 0) {
      if (options.dryRun) return response;
      throw AppError.validation(
        `表格里有 ${String(parsed.errors.length)} 个问题,未写入任何数据`,
        response.preview,
      );
    }

    const plan = planImport(parsed.rows, await this.loadState());
    response.preview = plan.preview;

    /*
      ⚠️ v4.16:负责人的**在职校验也要出现在预览里**,不能只在写入时才报。

      原来这一条只在 `execute`(事务内)拦。实测表现是:
      **预览 201 且干净 → 管理员确认 → 才拿到 400**。而预览里明明列出了
      「负责人改成 离职者(KC999)」这条变更 —— 等于先给了一份**注定会失败**的方案,
      让人以为可以提交。管理员应该在下拉确认之前就看到问题。

      `row: 0` 是本仓库对「不针对某一行的整体校验」的约定 ——
      前端 (`OrgImportPanel`) 会把它渲染成「整体校验:…」而不是「第 0 行」。

      写入路径在事务内**另有**一道同样的检查(`execute`):那一处才是权威的
      (挡住"预览之后、写入之前用户被停用"这种竞态);这里这一道是为了**早点说**。
    */
    const inactiveOwners = await this.findInactiveOwners(plan);
    if (inactiveOwners.length > 0) {
      response.preview = {
        ...response.preview,
        errors: [...response.preview.errors, ...inactiveOwners],
      };
    }

    if (plan.preview.errors.length > 0) {
      if (options.dryRun) return response;
      throw AppError.validation(
        `表格里有 ${String(plan.preview.errors.length)} 个问题,未写入任何数据`,
        plan.preview,
      );
    }

    if (options.dryRun) return response;

    response.applied = await this.execute(operator, plan);
    return response;
  }

  // ================================================================
  // 读 xlsx
  // ================================================================

  /**
   * 权限检查放在 service 而不是 controller。
   *
   * 这里的两个方法都是"能改全公司组织架构"的操作,漏一次检查就是一次
   * 越权写。放在 service 里,将来新增入口(定时任务、CLI、另一个 controller)
   * 都绕不过去。
   */
  private requireSuperAdmin(operator: Actor): void {
    if (!operator.isSuperAdmin) {
      throw AppError.forbidden('只有管理员能维护组织架构与人员');
    }
  }

  private async readRows(file: Buffer): Promise<RawRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      // exceljs 的 typings 收的是它自己那份 Buffer 定义,与 Node 的 Buffer 名义不同但兼容
      await workbook.xlsx.load(file as unknown as ExcelJS.Buffer);
    } catch {
      throw AppError.validation('这个文件不是有效的 Excel(.xlsx),请用系统给出的模板填写');
    }

    const sheet = workbook.getWorksheet(IMPORT_SHEET_NAME) ?? workbook.worksheets[0];
    if (sheet === undefined) throw AppError.validation('文件里没有任何工作表');
    if (sheet.rowCount > MAX_IMPORT_ROWS) {
      throw AppError.validation(`行数超过上限(${String(MAX_IMPORT_ROWS)} 行)`);
    }

    const rows: RawRow[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // 第 1 行是表头
      if (rowNumber === 1) return;
      const values = IMPORT_COLUMNS.map((_, index) => cellText(row.getCell(index + 1).value));
      rows.push({ rowNumber, values });
    });
    return rows;
  }

  // ================================================================
  // 现状快照
  // ================================================================

  /**
   * 找出计划里「负责人不是在用状态」的那些账号。
   *
   * 与 `OrgService.setOwner` / `createOrgNode` 的 `assertActiveUser` 是**同一条规则**;
   * 之所以单独有一段查询,是为了让它在**预览**阶段就能报出来(见 `run` 里的说明)。
   * 两个写入点都覆盖:**新建节点**的 `ownerEmployeeNo` 与**换所有者**的 `owner`。
   *
   * ⚠️ 本批**新建**的人不用查 —— 他们建出来就是 `active`(见 `execute` 的建人那一步)。
   * 这里只查"库里已经存在的账号",所以用 employeeNo / id 两个集合各查各的。
   */
  private async findInactiveOwners(plan: ImportPlan): Promise<RowIssue[]> {
    const employeeNos = new Set<string>();
    const ids = new Set<string>();
    for (const node of plan.createNodes) employeeNos.add(node.ownerEmployeeNo);
    for (const item of plan.setOwners) {
      if (item.owner.kind === 'new') employeeNos.add(item.owner.employeeNo);
      else ids.add(item.owner.id);
    }
    if (employeeNos.size === 0 && ids.size === 0) return [];

    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          ...(employeeNos.size === 0 ? [] : [{ employeeNo: { in: [...employeeNos] } }]),
          ...(ids.size === 0 ? [] : [{ id: { in: [...ids] } }]),
        ],
      },
      select: { employeeNo: true, name: true, status: true },
    });

    return users
      .filter((user) => user.status !== 'active')
      .map((user) => ({
        // row: 0 = 「整体校验」,前端会这么渲染(见 OrgImportPanel)
        row: 0,
        reason: `负责人 ${user.name}(${user.employeeNo})不是在用状态 —— 请改成在职人员`,
      }));
  }

  private async loadState(): Promise<CurrentState> {
    const [nodes, users, assignments] = await Promise.all([
      this.prisma.node.findMany({
        // v2.12 起没有"已删除但仍存在"的节点 —— 引用不存在的 ID 会得到
        // "该 ID 不存在"的明确报错。
        select: {
          id: true,
          title: true,
          parentId: true,
          depth: true,
          materializedPath: true,
          ownerId: true,
        },
      }),
      this.prisma.user.findMany({ select: { id: true, employeeNo: true, name: true } }),
      this.prisma.orgAssignment.findMany({ select: { userId: true, nodeId: true } }),
    ]);
    return { nodes, users, assignments };
  }

  // ================================================================
  // 执行
  // ================================================================

  /**
   * 单事务写入。
   *
   * 三条约束:
   * - **密码哈希在事务外算**。全员共用一个初始密码,所以只算一次就够;
   *   放进事务里会让 bcrypt 的几百毫秒占着一条数据库连接。
   * - **节点分两批插**(先部门后组)。`parent_id` 是自引用外键,
   *   PostgreSQL 是逐行即时检查的,同一批里子节点先落地就会撞外键。
   * - **id 在应用侧生成**。物化路径里含自身 id,一次 INSERT 就能写对。
   */
  private async execute(operator: Actor, plan: ImportPlan): Promise<OrgImportResult> {
    /*
      ⚠️⚠️ v4.31:`userIdByEmployeeNo` 必须**先装已存在的人**,而不只是本批新建的人。

      它原来只在「建人」那一步被填 —— 也就是**只含本批新建的账号**。
      而 `plan.createNodes[].ownerEmployeeNo` 是**表格里工号列的原样字符串**
      (`import.core.ts` 从「负责人 = 是」那一行的工号取的),
      这个人在库里**可能早就存在**(比如下载模板、加一个新部门、负责人填老员工)。
      于是 `resolveUserId(string)` 查不到 → 抛
      **「内部错误:新建的人「KC001」未落地」**,整批导入 400。

      实测(隔离库):建好超管 KC001 之后,导入一张只含三个新部门、负责人都是 KC001 的表 →
      `导入 -> 400 内部错误:新建的人「KC001」未落地`,**一个节点都没建**。
      而「负责人」本来就是一个**已存在的人** —— 这是最正常的用法。

      修法:进事务时先把库里的 `employeeNo → id` 装进去,建人那一步再覆盖/追加。
      两层来源合起来,`resolveUserId` 就能同时解析「已存在」与「本批新建」两种。
    */
    const existingUsers = await this.prisma.user.findMany({
      select: { id: true, employeeNo: true },
    });
    const userIdByEmployeeNo = new Map<string, string>(
      existingUsers.map((user) => [user.employeeNo, user.id]),
    );
    const nodeIdByKey = new Map<string, string>();

    // 全员同一个初始密码 —— 只在事务外算一次
    const passwordHash =
      plan.createUsers.length > 0 ? await this.passwords.hash(INITIAL_PASSWORD) : null;

    await this.prisma.$transaction(
      async (tx) => {
        // ---- 1. 建人 ----
        if (plan.createUsers.length > 0 && passwordHash !== null) {
          await tx.user.createMany({
            data: plan.createUsers.map((user) => {
              const id = randomUUID();
              userIdByEmployeeNo.set(user.employeeNo, id);
              return {
                id,
                employeeNo: user.employeeNo,
                name: user.name,
                passwordHash,
                // ⚠️ 必须一起做:只设统一初始密码而不强制改密 = 全员同密码上线
                mustChangePassword: true,
              };
            }),
          });
        }

        /*
          ⚠️⚠️ v4.15:**所有「负责人」必须在职** —— 与 `OrgService.setOwner` /
          `createOrgNode` 里的 `assertActiveUser` 是**同一条规则**,导入这条捷径原来漏了。

          Excel 的「负责人」列里填一个**已离职 / 已停用**的工号,原来照样会被写成
          `owner_id`(新建节点那一批和「换所有者」那一批都写)。后果不是"数据不好看",
          而是**那个节点从此没人管得了**:
            · 所有者自己登不上(离职/停用);
            · `canManage` 认的是"该节点或祖先链上的所有者"(§5.3),而换所有者
              本身又要求 `canManage` —— 于是**别人也接不过去**,只能超管逐个手改。

          REST 侧的 `setOwner` 一直有这道闸,只有导入绕过去了。
          放在这里(建完人、写节点之前)是因为两个写入点都要覆盖,而 `resolveUserId`
          此时已经能解析"本次新建的人"与"库里已存在的人"两种引用。

          按集合查一次,不在循环里 N+1。
        */
        const ownerIds = new Set<string>();
        for (const node of plan.createNodes) ownerIds.add(resolveUserId(node.ownerEmployeeNo));
        for (const item of plan.setOwners) ownerIds.add(resolveUserId(item.owner));
        if (ownerIds.size > 0) {
          const owners = await tx.user.findMany({
            where: { id: { in: [...ownerIds] } },
            select: { employeeNo: true, name: true, status: true },
          });
          const inactive = owners.filter((owner) => owner.status !== 'active');
          if (inactive.length > 0) {
            throw AppError.validation(
              `这些账号不是在用状态,不能当负责人:${inactive
                .map((owner) => `${owner.name}(${owner.employeeNo})`)
                .join('、')}`,
            );
          }
        }

        // ---- 2. 建节点(先部门、后组) ----
        const parentPathByKey = new Map<string, string>();
        /** 每个父节点下"下一个可用 position" —— 同一批里新建的多个兄弟不要互相撞位 */
        const nextPosition = new Map<string, number>();
        const lastPositionOf = async (parentId: string | null): Promise<number> => {
          const cacheKey = parentId ?? '__root__';
          const cached = nextPosition.get(cacheKey);
          if (cached !== undefined) {
            // ⚠️ 命中缓存后必须**把它推进一位**再返回。
            // 原实现直接 `return cached`:于是同一批里新建的每个兄弟都拿到
            // **同一个 position** —— 同级顺序变成随机的(取决于数据库返回顺序),
            // 而且不报任何错。这段注释原来写的就是"不要互相撞位",代码反着做了。
            nextPosition.set(cacheKey, cached + 1);
            return cached;
          }
          const last = await tx.node.findFirst({
            where: { parentId },
            orderBy: { position: 'desc' },
            select: { position: true },
          });
          const value = (last?.position ?? -1) + 1;
          // 存的是"下一个可用值",所以初次也要 +1
          nextPosition.set(cacheKey, value + 1);
          return value;
        };

        for (const depth of [0, 1]) {
          const batch = plan.createNodes.filter((node) => node.depth === depth);
          if (batch.length === 0) continue;

          const data = [];
          for (const node of batch) {
            const id = randomUUID();
            nodeIdByKey.set(node.key, id);

            const parentId =
              node.parentId ??
              (node.parentKey === null ? null : (nodeIdByKey.get(node.parentKey) ?? null));

            /*
              ⚠️⚠️ **物化路径必须与 `parentId` 一致 —— 这里原来把"父节点已存在"
              当成了"没有父节点"。**

              `planImport` 对**已存在**部门下的新组只填 `parentId`、不填 `parentKey`
              (见 `import.core.ts`:`parentKey: department.ref.kind === 'new' ? … : null`),
              而这里原来只从 `parentKey` 推路径 —— 于是 `parentPath` 是 `null`,
              最后写进去的是 `pathOfRoot(id)`,**一个一级节点的物化路径**,
              而 `parent_id` / `depth` 又是对的。三者互相矛盾。

              后果不是"排版不好看",而是**权限判定所依赖的那条链被写坏了**:
              `chainOf` 靠物化路径的前缀集合找祖先链(§5.2),路径成了根 ⇒ 这个组
              **没有祖先** ⇒ 部长对它失去编辑权、删除子树也扫不到它;
              更要紧的是,若它所属的部门是 `restricted`,这个组**不会继承受限**
              (默认 `public`,而链上又没有受限祖先)⇒ **所有人都能读**,
              连检索都会把它搜出来。这是与 §5.6「整棵子树继承,后代无法放开」
              直接冲突的一次静默保密失守。

              所以三个分支都要显式处理,而且**取不到父路径就报错** ——
              绝不再退回"当成一级节点"这个默认值。
            */
            let materializedPath: string;
            if (parentId === null) {
              // 真正的一级节点(部门)
              materializedPath = pathOfRoot(id);
            } else if (node.parentKey !== null) {
              // 父节点是**本次新建**的 —— 路径已经在上面那张表里
              const parentPath = parentPathByKey.get(node.parentKey);
              if (parentPath === undefined) {
                throw new Error(`导入失败:找不到本次新建父节点 ${node.parentKey} 的路径`);
              }
              materializedPath = pathOfChild(parentPath, id);
            } else {
              // 父节点是**库里已存在**的部门 —— 路径只能从库里取
              const parent = await tx.node.findUnique({
                where: { id: parentId },
                select: { materializedPath: true },
              });
              if (parent === null) {
                throw new Error(`导入失败:父节点 ${parentId} 不存在`);
              }
              materializedPath = pathOfChild(parent.materializedPath, id);
            }
            parentPathByKey.set(node.key, materializedPath);

            const ownerId = resolveUserId(node.ownerEmployeeNo);
            data.push({
              id,
              parentId,
              kind: 'space',
              title: node.name,
              position: await lastPositionOf(parentId),
              depth: node.depth,
              materializedPath,
              ownerId,
              createdBy: operator.id,
              updatedBy: operator.id,
            });
          }
          await tx.node.createMany({ data });
        }

        // ---- 3. 归属 ----
        if (plan.createAssignments.length > 0) {
          const seen = new Set<string>();
          const data: { userId: string; nodeId: string }[] = [];
          for (const item of plan.createAssignments) {
            const userId = resolveUserId(item.user);
            const nodeId = resolveNodeId(item.node);
            const key = `${userId}\u0000${nodeId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            data.push({ userId, nodeId });
          }
          await tx.orgAssignment.createMany({ data, skipDuplicates: true });
        }

        // ---- 4. 换所有者 ----
        for (const item of plan.setOwners) {
          await tx.node.update({
            where: { id: item.nodeId },
            data: {
              ownerId: resolveUserId(item.owner),
              version: { increment: 1 },
              updatedBy: operator.id,
            },
          });
        }

        // ---- 5. 改名(节点与人员) ----
        for (const item of plan.renameNodes) {
          await tx.node.update({
            where: { id: item.nodeId },
            data: { title: item.to, version: { increment: 1 }, updatedBy: operator.id },
          });
        }
        for (const item of plan.renameUsers) {
          await tx.user.update({ where: { id: item.userId }, data: { name: item.to } });
        }
      },
      // 几百人的首次导入会明显超过默认的 5 秒
      { timeout: 120_000, maxWait: 15_000 },
    );

    // 归属变了 → 组织范围跟着变 → 权限缓存必须整体失效
    if (plan.createUsers.length > 0 || plan.createNodes.length > 0 || plan.setOwners.length > 0) {
      await this.org.invalidateAllGenerations();
    }

    const result: OrgImportResult = {
      createdUsers: plan.createUsers.length,
      createdNodes: plan.createNodes.length,
      createdAssignments: plan.createAssignments.length,
      updatedNames: plan.renameUsers.length + plan.renameNodes.length,
      updatedOwners: plan.setOwners.length,
    };

    // 一次导入写**一条**审计,不逐行写 —— 几百行会把这个表刷爆,
    // 而"谁在什么时候导入了多少人"才是需要追溯的信息。
    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.import',
      targetType: 'org',
      targetId: operator.id,
      detail: { ...result },
    });

    this.logger.log(
      `组织架构导入完成:建人 ${String(result.createdUsers)}、建节点 ${String(result.createdNodes)}、` +
        `归属 ${String(result.createdAssignments)}、改名 ${String(result.updatedNames)}、换所有者 ${String(result.updatedOwners)}`,
    );

    return result;

    function resolveUserId(ref: UserRef | string): string {
      if (typeof ref === 'string') {
        const found = userIdByEmployeeNo.get(ref);
        if (found === undefined) {
          throw AppError.validation(`内部错误:新建的人「${ref}」未落地`);
        }
        return found;
      }
      if (ref.kind === 'existing') return ref.id;
      const found = userIdByEmployeeNo.get(ref.employeeNo);
      if (found === undefined) {
        // 走到这里说明计划里引用了本批要新建的人,但建人那一步没覆盖到
        throw AppError.validation(`内部错误:新建的人「${ref.employeeNo}」未落地`);
      }
      return found;
    }

    function resolveNodeId(ref: NodeRef): string {
      if (ref.kind === 'existing') return ref.id;
      const found = nodeIdByKey.get(ref.key);
      if (found === undefined) {
        throw AppError.validation(`内部错误:新建的节点「${ref.key}」未落地`);
      }
      return found;
    }
  }
}

// ==================================================================
// 小工具
// ==================================================================

/** 把 exceljs 的单元格值取成字符串。表格里的东西花样比想象的多。 */
function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const candidate = value as {
      richText?: { text: string }[];
      text?: string;
      result?: unknown;
      error?: string;
    };
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((part) => part.text).join('');
    }
    if (typeof candidate.text === 'string') return candidate.text;
    if ('result' in candidate) return cellText(candidate.result as ExcelJS.CellValue);
  }

  return String(value);
}

/** 「填写说明」表的内容。放在表里而不是只写进文档 —— 填表的人不会去翻文档。 */
const HELP_LINES: { column: string; how: string }[] = [
  {
    column: '工号',
    how: '必填。登录用的就是工号。**一旦定了就不要改** —— 改了系统会当成另一个人,他名下文档的作者也会断。',
  },
  { column: '姓名', how: '必填。与系统里不一致时**以表格为准**(改名的正常情况)。' },
  { column: '部门', how: '必填。一级组织。系统里没有的部门会自动创建。' },
  { column: '组 / 项目', how: '可空。留空表示这个人只属于部门本身。' },
  {
    column: '负责人',
    how: '填「是」表示这一行的人是**这一行最深那个节点**的负责人:填了组就是组长,没填就是部长。\n每个部门必须有一个负责人(新建的部门尤其),一个节点只能有一个。',
  },
  {
    column: '部门ID(勿改)',
    how: '系统生成的只读列。**不要手工编辑**。它的作用是:部门改名之后,靠 ID 仍能认出它,而不是当成新建。',
  },
  { column: '组ID(勿改)', how: '同上,对应「组 / 项目」那一列。' },
  {
    column: '一行代表什么',
    how: '一行 = 一个人在一个节点上的归属。同一个人出现多行是**正常**的 —— 表示他同属多个部门 / 组 / 项目。',
  },
  { column: '怎么加人', how: '在表格末尾**追加行**,不要在中间插行或删除已有行。' },
  {
    column: '怎么调岗',
    how: '⚠️ 本表是**增量**语义:加一行新归属即可,但**移出旧归属要去界面上做**。\n表格里"没写"与"要删掉"无法区分,所以这一步必须手工。',
  },
  {
    column: '怎么处理离职',
    how: '删除表格里的行**不会**让任何人离职。离职请到「人员管理」里把状态改成"已离职"。',
  },
  {
    column: '密码',
    how: `不需要填。新账号的初始密码统一是 ${INITIAL_PASSWORD},首次登录会强制要求改成「8 位以上且同时含字母与数字」的密码。`,
  },
];
