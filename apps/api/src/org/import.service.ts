/**
 * 组织架构导入 —— IO 层。对应 DESIGN.md §8.5。
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
   * 后者必然有人只填新增的几行就上传(见 §8.5 对"覆盖 vs 增量"的讨论)。
   *
   * 一行 = 一个人在一个节点上的归属;同一个人多行就是多归属。
   */
  async buildTemplate(operator: Actor): Promise<Buffer> {
    this.requireSuperAdmin(operator);

    const [nodes, users, assignments] = await Promise.all([
      this.prisma.node.findMany({
        where: { deletedAt: null },
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
      .sort((a, b) => (a.depth === b.depth ? orderOf(a).localeCompare(orderOf(b)) : a.depth - b.depth));

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

    if (!options.dryRun && options.expectedHash !== undefined && options.expectedHash !== contentHash) {
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

  private async loadState(): Promise<CurrentState> {
    const [nodes, users, assignments] = await Promise.all([
      this.prisma.node.findMany({
        // 已删除的节点**不进快照** —— 这样表格里引用它时会得到
        // "该 ID 不存在(可能已被删除)"的明确报错,而不是静默把归属挂到回收站里的节点上
        where: { deletedAt: null },
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
    const userIdByEmployeeNo = new Map<string, string>();
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

        // ---- 2. 建节点(先部门、后组) ----
        const parentPathByKey = new Map<string, string>();
        /** 每个父节点下"下一个可用 position" —— 同一批里新建的多个兄弟不要互相撞位 */
        const nextPosition = new Map<string, number>();
        const lastPositionOf = async (parentId: string | null): Promise<number> => {
          const cacheKey = parentId ?? '__root__';
          const cached = nextPosition.get(cacheKey);
          if (cached !== undefined) return cached;
          const last = await tx.node.findFirst({
            where: { parentId, deletedAt: null },
            orderBy: { position: 'desc' },
            select: { position: true },
          });
          const value = (last?.position ?? -1) + 1;
          nextPosition.set(cacheKey, value);
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
              node.parentId ?? (node.parentKey === null ? null : (nodeIdByKey.get(node.parentKey) ?? null));
            const parentPath = node.parentKey === null ? null : (parentPathByKey.get(node.parentKey) ?? null);
            const materializedPath =
              parentPath === null ? pathOfRoot(id) : pathOfChild(parentPath, id);
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
  { column: '工号', how: '必填。登录用的就是工号。**一旦定了就不要改** —— 改了系统会当成另一个人,他名下文档的作者也会断。' },
  { column: '姓名', how: '必填。与系统里不一致时**以表格为准**(改名的正常情况)。' },
  { column: '部门', how: '必填。一级组织。系统里没有的部门会自动创建。' },
  { column: '组 / 项目', how: '可空。留空表示这个人只属于部门本身。' },
  { column: '负责人', how: '填「是」表示这一行的人是**这一行最深那个节点**的负责人:填了组就是组长,没填就是部长。\n每个部门必须有一个负责人(新建的部门尤其),一个节点只能有一个。' },
  { column: '部门ID(勿改)', how: '系统生成的只读列。**不要手工编辑**。它的作用是:部门改名之后,靠 ID 仍能认出它,而不是当成新建。' },
  { column: '组ID(勿改)', how: '同上,对应「组 / 项目」那一列。' },
  { column: '一行代表什么', how: '一行 = 一个人在一个节点上的归属。同一个人出现多行是**正常**的 —— 表示他同属多个部门 / 组 / 项目。' },
  { column: '怎么加人', how: '在表格末尾**追加行**,不要在中间插行或删除已有行。' },
  { column: '怎么调岗', how: '⚠️ 本表是**增量**语义:加一行新归属即可,但**移出旧归属要去界面上做**。\n表格里"没写"与"要删掉"无法区分,所以这一步必须手工。' },
  { column: '怎么处理离职', how: '删除表格里的行**不会**让任何人离职。离职请到「人员管理」里把状态改成"已离职"。' },
  { column: '密码', how: `不需要填。新账号的初始密码统一是 ${INITIAL_PASSWORD},首次登录会强制要求改成「8 位以上且同时含字母与数字」的密码。` },
];
