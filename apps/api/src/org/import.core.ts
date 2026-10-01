/**
 * 组织架构导入的**纯逻辑** —— 解析、校验、推导目标结构、算差异。
 * 对应 DESIGN.md §8.4。
 *
 * 刻意与 exceljs / Prisma 分开,有两个理由:
 *
 * 1. **这一层是"错了不会立刻报错"的高危逻辑。** 归属算错、所有者认错人,
 *    表现是静默的越权或静默的失权,几周后才会有人发现"某篇文档莫名其妙改不了"。
 *    拆成纯函数才能被单测整体覆盖。
 * 2. **预览(dryRun)与确认写入必须共用同一份逻辑。** 两边各写一份的话迟早
 *    会算出不同结果,而管理员是照着预览做决定的 —— 那种偏差比没有预览更糟。
 *
 * 语义:**增量**(只加不删)。表格里没出现的人与节点一律不动。
 * 这是用户明确选的(§8.4),代价是调岗需要两步(导入新归属 + 界面移出旧归属)。
 *
 * ⚠️ 一个刻意的结构选择:**每一行在解析阶段就被钉死到具体节点上**
 * (`ResolvedRow.node`),后面的差异计算只消费这个结果,不再重新判断"这行属于谁"。
 * 早期版本是"解析一遍、写归属时再按名字匹配一遍",两套判据一旦漂移,
 * 就会把归属写到别的节点上,而且**不报任何错**。
 */

import type { OrgImportPreview } from '@knowledgecool/shared';

// ==================================================================
// 模板列定义(唯一事实来源:模板生成与解析都读它)
// ==================================================================

/**
 * 列的**顺序即数组顺序**。生成模板与解析上传**都读这一份** ——
 * 两处各写一份的话,改列时会一边改一边漏,而漏掉的表现是"姓名写进了工号列"。
 */
export const IMPORT_COLUMNS = [
  { key: 'employeeNo', header: '工号', width: 18 },
  { key: 'name', header: '姓名', width: 14 },
  { key: 'department', header: '部门', width: 22 },
  { key: 'group', header: '组 / 项目', width: 22 },
  { key: 'isOwner', header: '负责人', width: 10 },
  { key: 'departmentId', header: '部门ID(勿改)', width: 38 },
  { key: 'groupId', header: '组ID(勿改)', width: 38 },
] as const;

export type ImportColumnKey = (typeof IMPORT_COLUMNS)[number]['key'];

export const IMPORT_COLUMN_COUNT = IMPORT_COLUMNS.length;

export function columnIndex(key: ImportColumnKey): number {
  return IMPORT_COLUMNS.findIndex((column) => column.key === key);
}

export const IMPORT_SHEET_NAME = '人员名单';
export const IMPORT_HELP_SHEET_NAME = '填写说明';

/** 工号允许的字符。刻意不用数字类型:工号常带字母前缀与前导零。 */
const EMPLOYEE_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ==================================================================
// 解析
// ==================================================================

export interface RawRow {
  /** Excel 里的行号(1 起,含表头行),报错时直接指给管理员看 */
  rowNumber: number;
  /** 按列顺序的值,已 trim;空单元格为 null */
  values: readonly (string | null)[];
}

export interface RowIssue {
  row: number;
  reason: string;
}

export interface ParsedRow {
  rowNumber: number;
  employeeNo: string;
  name: string;
  department: string;
  /** 表格里填的部门 ID(只读列)。用于在部门**改名**后仍能认出它 */
  departmentId: string | null;
  group: string | null;
  groupId: string | null;
  /** 这一行的人是不是「这一行最深那个节点」的负责人 */
  isOwner: boolean;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** 致命问题:非空则**禁止写入** */
  errors: RowIssue[];
  /** 被跳过的行:不影响写入,但要让管理员知道有东西没被处理 */
  ignored: RowIssue[];
}

function cell(values: readonly (string | null)[], key: ImportColumnKey): string | null {
  const value = values[columnIndex(key)];
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 「负责人」列怎么算填了「是」。接受几种常见写法。 */
export function isOwnerMark(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.toLowerCase();
  return (
    normalized === '是' ||
    normalized === 'y' ||
    normalized === 'yes' ||
    normalized === 'true' ||
    normalized === '1'
  );
}

/**
 * 解析数据行。
 *
 * 三条约定,都是为了"能看出错在哪"而不是"猜":
 * - **整行全空 → 静默跳过**(Excel 尾部常有空行,报出来是噪音)
 * - 有内容但缺必填 → 记进 `errors`,并**阻断整批写入**
 * - 同一人同一节点的重复行 → 记进 `ignored`,照常写入(幂等)
 */
export function parseRows(raw: readonly RawRow[]): ParseResult {
  const rows: ParsedRow[] = [];
  const errors: RowIssue[] = [];
  const ignored: RowIssue[] = [];

  /** 工号 → 首次出现的姓名。用来发现"同一工号两个姓名"。 */
  const nameByEmployeeNo = new Map<string, { name: string; row: number }>();
  /** 人 + 节点 的去重键 */
  const seen = new Set<string>();

  for (const source of raw) {
    const employeeNo = cell(source.values, 'employeeNo');
    const name = cell(source.values, 'name');
    const department = cell(source.values, 'department');
    const group = cell(source.values, 'group');
    const departmentId = cell(source.values, 'departmentId');
    const groupId = cell(source.values, 'groupId');
    const ownerMark = cell(source.values, 'isOwner');

    // 整行全空:不看、不报。Excel 保存时很容易带出成百上千个空行,
    // 把它们当"错误"报出来只会让真正的问题被淹掉。
    const allEmpty =
      employeeNo === null &&
      name === null &&
      department === null &&
      group === null &&
      departmentId === null &&
      groupId === null &&
      ownerMark === null;
    if (allEmpty) continue;

    const problems: string[] = [];
    if (employeeNo === null) problems.push('工号不能为空');
    else if (!EMPLOYEE_NO_PATTERN.test(employeeNo)) {
      problems.push(
        `工号「${employeeNo}」格式不对(只能是字母、数字、点、下划线、短横,且以字母或数字开头)`,
      );
    }
    if (name === null) problems.push('姓名不能为空');
    if (department === null) problems.push('部门不能为空');
    if (departmentId !== null && !UUID_PATTERN.test(departmentId)) {
      problems.push('部门ID 不是合法的 UUID —— 那一列请勿手工编辑');
    }
    if (groupId !== null && !UUID_PATTERN.test(groupId)) {
      problems.push('组ID 不是合法的 UUID —— 那一列请勿手工编辑');
    }
    if (groupId !== null && group === null) {
      problems.push('填了组ID 却没有填组名,请重新下载模板而不是手工拼这一行');
    }

    if (problems.length > 0) {
      errors.push({ row: source.rowNumber, reason: problems.join('；') });
      continue;
    }

    // 到这里三个必填项一定非空,但 TypeScript 看不出来,显式收窄
    const no = employeeNo ?? '';
    const realName = name ?? '';
    const dept = department ?? '';

    const known = nameByEmployeeNo.get(no);
    if (known === undefined) {
      nameByEmployeeNo.set(no, { name: realName, row: source.rowNumber });
    } else if (known.name !== realName) {
      // 同一工号两个姓名 —— 静默选一个会让某个人的名字被悄悄改掉
      errors.push({
        row: source.rowNumber,
        reason: `工号「${no}」在第 ${String(known.row)} 行叫「${known.name}」,这里却写「${realName}」;同一工号只能对应一个姓名`,
      });
      continue;
    }

    const dedupeKey = `${no}\u0000${departmentId ?? dept}\u0000${groupId ?? group ?? ''}`;
    if (seen.has(dedupeKey)) {
      ignored.push({ row: source.rowNumber, reason: `重复行(工号 ${no} 已在同一节点下出现过)` });
      continue;
    }
    seen.add(dedupeKey);

    rows.push({
      rowNumber: source.rowNumber,
      employeeNo: no,
      name: realName,
      department: dept,
      departmentId,
      group,
      groupId,
      isOwner: isOwnerMark(ownerMark),
    });
  }

  return { rows, errors, ignored };
}

// ==================================================================
// 现状快照
// ==================================================================

export interface CurrentNode {
  id: string;
  title: string;
  parentId: string | null;
  depth: number;
  materializedPath: string;
  ownerId: string;
}

export interface CurrentUserRow {
  id: string;
  employeeNo: string;
  name: string;
}

export interface CurrentState {
  nodes: readonly CurrentNode[];
  users: readonly CurrentUserRow[];
  assignments: readonly { userId: string; nodeId: string }[];
}

// ==================================================================
// 目标结构与差异
// ==================================================================

export type NodeRef = { kind: 'existing'; id: string } | { kind: 'new'; key: string };
export type UserRef = { kind: 'existing'; id: string } | { kind: 'new'; employeeNo: string };

/** 计划新建的节点。父节点用 `key` / `parentId` 二选一表达。 */
export interface PlanNewNode {
  /** 本批内的临时键,形如 `d:<部门名>` / `g:<部门键>/<组名>` */
  key: string;
  name: string;
  parentKey: string | null;
  /** 父节点已存在时直接给 id(省一次本批内查找) */
  parentId: string | null;
  depth: number;
  /** 新建节点的所有者工号 —— 若该人也在本批新建中,执行器会先建人 */
  ownerEmployeeNo: string;
}

export interface ImportPlan {
  preview: OrgImportPreview;
  /** ⚠️ 顺序保证父先于子(先部门后组),执行器可直接顺序插入 */
  createNodes: PlanNewNode[];
  createUsers: { employeeNo: string; name: string }[];
  renameUsers: { userId: string; employeeNo: string; from: string; to: string }[];
  renameNodes: { nodeId: string; from: string; to: string }[];
  createAssignments: { user: UserRef; node: NodeRef }[];
  /** 只针对**已存在**节点;新建节点的所有者随创建一起写 */
  setOwners: { nodeId: string; owner: UserRef; ownerName: string; nodePath: string }[];
}

interface ResolvedNode {
  ref: NodeRef;
  /** 表格里写的名字 —— **表格是唯一事实来源**,即使现有节点叫别的名字 */
  name: string;
  /** 现有节点在库里的名字(新建的为 null)。用来识别"改名" */
  currentTitle: string | null;
  ownerEmployeeNos: { employeeNo: string; row: number }[];
}

interface ResolvedDepartment extends ResolvedNode {
  key: string;
  groups: Map<string, ResolvedGroup>;
}

interface ResolvedGroup extends ResolvedNode {
  key: string;
  departmentKey: string;
}

/**
 * 每一行解析后的归属落点。
 * **在解析阶段就确定,后面的差异计算只消费它,不再重新判断。**
 */
interface ResolvedRow {
  row: ParsedRow;
  departmentKey: string;
  /** null = 这一行归属在部门本身 */
  groupKey: string | null;
}

function emptyPreview(ignored: RowIssue[], errors: RowIssue[]): OrgImportPreview {
  return {
    newUsers: [],
    renamedUsers: [],
    newAssignments: [],
    newNodes: [],
    renamedNodes: [],
    ownerChanges: [],
    ignoredRows: ignored,
    errors,
  };
}

function emptyPlan(preview: OrgImportPreview): ImportPlan {
  return {
    preview,
    createNodes: [],
    createUsers: [],
    renameUsers: [],
    renameNodes: [],
    createAssignments: [],
    setOwners: [],
  };
}

/**
 * 从解析出的行推导目标结构,并与现状比对出差异。
 *
 * 有致命问题时返回**空的 ops** + 带 `errors` 的 preview —— 差异是给
 * "确认写入"看的,而这时候压根不允许写入,继续算只会给出误导性的一份预览。
 */
export function planImport(parsed: readonly ParsedRow[], current: CurrentState): ImportPlan {
  const errors: RowIssue[] = [];
  const ignored: RowIssue[] = [];

  const nodeById = new Map(current.nodes.map((node) => [node.id, node]));
  const userByEmployeeNo = new Map(current.users.map((user) => [user.employeeNo, user]));
  const userNameById = new Map(current.users.map((user) => [user.id, user]));
  const departmentByTitle = new Map<string, CurrentNode>();
  const childrenOf = new Map<string, CurrentNode[]>();
  for (const node of current.nodes) {
    const key = node.parentId ?? '';
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), node]);
    if (node.depth === 0) departmentByTitle.set(node.title, node);
  }

  // ---------- 第一步:把每一行钉到一个具体节点上 ----------

  const departments = new Map<string, ResolvedDepartment>();
  const resolvedRows: ResolvedRow[] = [];

  /** 取(或建)一个部门的解析结果。 */
  const departmentOf = (row: ParsedRow): ResolvedDepartment | null => {
    // 不写初始值:两条分支都会赋值,给了初始值反而是死代码
    let existing: CurrentNode | null;

    if (row.departmentId !== null) {
      // 有 ID 就优先用 ID:部门改名后名称匹配会失效,这正是那一列存在的理由
      const found = nodeById.get(row.departmentId);
      if (found === undefined) {
        errors.push({
          row: row.rowNumber,
          reason: `部门ID「${row.departmentId}」在系统里不存在(可能已被删除),请重新下载模板`,
        });
        return null;
      }
      if (found.depth !== 0) {
        errors.push({
          row: row.rowNumber,
          reason: `部门ID「${row.departmentId}」指向的不是一级部门`,
        });
        return null;
      }
      existing = found;
    } else {
      existing = departmentByTitle.get(row.department) ?? null;
    }

    const key = existing === null ? `d:${row.department}` : `i:${existing.id}`;
    const known = departments.get(key);
    if (known !== undefined) return known;

    const department: ResolvedDepartment = {
      key,
      ref: existing === null ? { kind: 'new', key } : { kind: 'existing', id: existing.id },
      name: row.department,
      currentTitle: existing?.title ?? null,
      ownerEmployeeNos: [],
      groups: new Map(),
    };
    departments.set(key, department);
    return department;
  };

  /** 取(或建)一个组的解析结果。返回 null 表示这一行有问题,已记错误。 */
  const groupOf = (row: ParsedRow, department: ResolvedDepartment): ResolvedGroup | null => {
    const groupName = row.group;
    if (groupName === null) return null;

    let existing: CurrentNode | null = null;
    if (row.groupId !== null) {
      const found = nodeById.get(row.groupId);
      if (found === undefined) {
        errors.push({
          row: row.rowNumber,
          reason: `组ID「${row.groupId}」在系统里不存在(可能已被删除),请重新下载模板`,
        });
        return null;
      }
      if (found.depth !== 1) {
        errors.push({ row: row.rowNumber, reason: `组ID「${row.groupId}」指向的不是二级节点` });
        return null;
      }
      // 组必须挂在这一行的部门下 —— 否则表格里的部门列与组 ID 自相矛盾
      if (department.ref.kind === 'existing' && found.parentId !== department.ref.id) {
        errors.push({
          row: row.rowNumber,
          reason: `组「${groupName}」不在部门「${row.department}」下,请检查表格`,
        });
        return null;
      }
      existing = found;
    } else if (department.ref.kind === 'existing') {
      existing =
        (childrenOf.get(department.ref.id) ?? []).find((child) => child.title === groupName) ??
        null;
    }

    const key = existing === null ? `g:${department.key}/${groupName}` : `i:${existing.id}`;
    const known = department.groups.get(key);
    if (known !== undefined) return known;

    const group: ResolvedGroup = {
      key,
      departmentKey: department.key,
      ref: existing === null ? { kind: 'new', key } : { kind: 'existing', id: existing.id },
      name: groupName,
      currentTitle: existing?.title ?? null,
      ownerEmployeeNos: [],
    };
    department.groups.set(key, group);
    return group;
  };

  for (const row of parsed) {
    const department = departmentOf(row);
    if (department === null) continue;

    const group = groupOf(row, department);
    if (row.group !== null && group === null) continue; // groupOf 已记错误

    resolvedRows.push({ row, departmentKey: department.key, groupKey: group?.key ?? null });

    // 负责人标记落在「这一行最深的那个节点」上
    if (row.isOwner) {
      const target: ResolvedNode = group ?? department;
      target.ownerEmployeeNos.push({ employeeNo: row.employeeNo, row: row.rowNumber });
    }
  }

  // ---------- 第二步:一致性校验 ----------

  for (const department of departments.values()) {
    // 同一个现有节点被两个不同的名字指到 —— 多半是"改了名 + 又留了一行旧名字"
    const distinctNames = new Set<string>();
    for (const item of resolvedRows) {
      if (item.departmentKey !== department.key) continue;
      distinctNames.add(item.row.department);
      const group = item.groupKey === null ? null : department.groups.get(item.groupKey);
      if (group !== undefined && group !== null)
        distinctNames.add(`${item.row.department}\u0000${group.name}`);
    }
    if (department.ref.kind === 'existing' && departmentNamesConflict(distinctNames)) {
      errors.push({
        row: 0,
        reason: `部门「${department.currentTitle ?? department.name}」在表格里出现了多个不同名字,请统一成一个`,
      });
    }

    // **每个部门必须恰好一个负责人,但只对新建的部门硬性要求。**
    //
    // 现有部门没写负责人 → **保持原所有者不变**,不报错。这条很要紧:
    // 否则「下载模板 → 原样上传」会报一堆错,因为部长常常并不是本部门的
    // 归属成员,模板里就没有他那一行。增量语义的意思是"没写就不动",
    // 而不是"没写就当作要清空"。
    //
    // 两个负责人则任何一种解释都不对(谁说了算没定),直接拦下来。
    if (department.ref.kind === 'new' && department.ownerEmployeeNos.length === 0) {
      errors.push({
        row: 0,
        reason: `新建的部门「${department.name}」必须有一行「负责人」为是 —— 否则没人能管它`,
      });
    } else if (department.ownerEmployeeNos.length > 1) {
      const rows = department.ownerEmployeeNos.map((item) => item.row).join('、');
      errors.push({
        row: 0,
        reason: `部门「${department.name}」有多个负责人(第 ${rows} 行),一个部门只能有一个`,
      });
    }

    for (const group of department.groups.values()) {
      if (group.ownerEmployeeNos.length > 1) {
        const rows = group.ownerEmployeeNos.map((item) => item.row).join('、');
        errors.push({
          row: 0,
          reason: `组「${group.name}」有多个负责人(第 ${rows} 行),一个节点只能有一个`,
        });
      }
    }
  }

  if (errors.length > 0) {
    return emptyPlan(emptyPreview(ignored, errors));
  }

  // ---------- 第三步:算差异 ----------

  const assignmentSet = new Set(current.assignments.map((a) => `${a.userId}\u0000${a.nodeId}`));
  const createUsers: ImportPlan['createUsers'] = [];
  const createNodes: PlanNewNode[] = [];
  const createAssignments: ImportPlan['createAssignments'] = [];
  const setOwners: ImportPlan['setOwners'] = [];
  const renameUsers: ImportPlan['renameUsers'] = [];
  const renameNodes: ImportPlan['renameNodes'] = [];
  const newUserPaths = new Map<string, string[]>();
  const newUserNames = new Map<string, string>();

  const userRefOf = (employeeNo: string, fallbackName: string): UserRef => {
    const existing = userByEmployeeNo.get(employeeNo);
    if (existing !== undefined) return { kind: 'existing', id: existing.id };
    if (!newUserNames.has(employeeNo)) {
      newUserNames.set(employeeNo, fallbackName);
      createUsers.push({ employeeNo, name: fallbackName });
    }
    return { kind: 'new', employeeNo };
  };

  /** 新建节点的预览路径 —— 用表格里的名字拼,不查库。 */
  const newPathOf = (item: ResolvedRow, department: ResolvedDepartment): string => {
    const group = item.groupKey === null ? null : department.groups.get(item.groupKey);
    return group === null || group === undefined
      ? department.name
      : `${department.name} / ${group.name}`;
  };

  // ---- 建节点(父先于子) ----

  // 预览里的路径在**这里**就拼好 —— 后面再回头按 key 反查父节点的名字,
  // 既绕又容易拼错(而且新部门的父是 null,反查必然失败)。
  const newNodes: OrgImportPreview['newNodes'] = [];
  const renamedNodes: OrgImportPreview['renamedNodes'] = [];

  for (const department of departments.values()) {
    if (department.ref.kind !== 'new') continue;
    createNodes.push({
      key: department.key,
      name: department.name,
      parentKey: null,
      parentId: null,
      depth: 0,
      ownerEmployeeNo: department.ownerEmployeeNos[0]?.employeeNo ?? '',
    });
    newNodes.push({ path: department.name });
  }
  for (const department of departments.values()) {
    for (const group of department.groups.values()) {
      if (group.ref.kind !== 'new') continue;
      createNodes.push({
        key: group.key,
        name: group.name,
        parentKey: department.ref.kind === 'new' ? department.key : null,
        parentId: department.ref.kind === 'existing' ? department.ref.id : null,
        depth: 1,
        // 组没填负责人时由部门负责人兼 —— 部长的权限本来就覆盖整棵子树
        ownerEmployeeNo:
          group.ownerEmployeeNos[0]?.employeeNo ?? department.ownerEmployeeNos[0]?.employeeNo ?? '',
      });
      newNodes.push({ path: `${department.name} / ${group.name}` });
    }
  }

  // ---- 改名 / 换所有者(仅现有节点) ----

  for (const department of departments.values()) {
    if (department.ref.kind === 'existing' && department.currentTitle !== null) {
      if (department.currentTitle !== department.name) {
        renameNodes.push({
          nodeId: department.ref.id,
          from: department.currentTitle,
          to: department.name,
        });
        renamedNodes.push({
          nodePath: department.name,
          from: department.currentTitle,
          to: department.name,
        });
      }
    }
    for (const group of department.groups.values()) {
      if (group.ref.kind === 'existing' && group.currentTitle !== null) {
        if (group.currentTitle !== group.name) {
          renameNodes.push({ nodeId: group.ref.id, from: group.currentTitle, to: group.name });
          renamedNodes.push({
            nodePath: `${department.name} / ${group.name}`,
            from: group.currentTitle,
            to: group.name,
          });
        }
      }
    }
  }

  const ownerChanges: OrgImportPreview['ownerChanges'] = [];

  /**
   * 换所有者。
   *
   * ⚠️ **只认表格里显式写了「负责人 = 是」的行,不做任何"兜底继承"。**
   * 曾想给"没写负责人的组"继承部门负责人,但那会破坏一条重要的性质:
   * 下载模板后原样上传应当是**零差异**。兜底一旦存在,每次导入都会
   * 把没写负责人的组建模成"改成部长",而管理员根本没表达过这个意思。
   */
  const applyOwner = (node: ResolvedNode, pathLabel: string): void => {
    const ownerNo = node.ownerEmployeeNos[0]?.employeeNo;
    if (ownerNo === undefined) return;
    if (node.ref.kind === 'new') return; // 新建节点随创建一起写所有者

    const currentNode = nodeById.get(node.ref.id);
    if (currentNode === undefined) return;

    const ownerName = userByEmployeeNo.get(ownerNo)?.name ?? newUserNames.get(ownerNo) ?? ownerNo;
    // 用 ownerName 调 userRefOf:若该人已存在,名字一致就不会被登记成改名
    const ownerRef = userRefOf(ownerNo, ownerName);

    const currentOwner = userNameById.get(currentNode.ownerId);
    if (currentOwner !== undefined && currentOwner.employeeNo === ownerNo) return;

    setOwners.push({ nodeId: node.ref.id, owner: ownerRef, ownerName, nodePath: pathLabel });
    ownerChanges.push({
      nodePath: pathLabel,
      fromName: currentOwner?.name ?? null,
      toName: ownerName,
    });
  };

  for (const department of departments.values()) {
    applyOwner(department, department.name);
    for (const group of department.groups.values()) {
      applyOwner(group, `${department.name} / ${group.name}`);
    }
  }

  // ---- 建人 / 改名 / 加归属 ----

  const renamedUsers: OrgImportPreview['renamedUsers'] = [];
  const newAssignments: OrgImportPreview['newAssignments'] = [];

  for (const item of resolvedRows) {
    const department = departments.get(item.departmentKey);
    if (department === undefined) continue;

    const group = item.groupKey === null ? null : (department.groups.get(item.groupKey) ?? null);
    const node: NodeRef = group?.ref ?? department.ref;
    const pathLabel = newPathOf(item, department);

    // 姓名与库里不一致 → 以表格为准。多个节点各出现一次这人也只登记一次(见下)。
    const existingUser = userByEmployeeNo.get(item.row.employeeNo);
    if (existingUser !== undefined && existingUser.name !== item.row.name) {
      if (!renamedUsers.some((entry) => entry.employeeNo === item.row.employeeNo)) {
        renamedUsers.push({
          employeeNo: item.row.employeeNo,
          from: existingUser.name,
          to: item.row.name,
        });
        renameUsers.push({
          userId: existingUser.id,
          employeeNo: item.row.employeeNo,
          from: existingUser.name,
          to: item.row.name,
        });
      }
    }

    const userRef = userRefOf(item.row.employeeNo, item.row.name);

    if (userRef.kind === 'existing' && node.kind === 'existing') {
      // 幂等:已有的归属不重复写
      if (assignmentSet.has(`${userRef.id}\u0000${node.id}`)) continue;
      assignmentSet.add(`${userRef.id}\u0000${node.id}`);
    }

    createAssignments.push({ user: userRef, node });
    newAssignments.push({ employeeNo: item.row.employeeNo, nodePath: pathLabel });

    if (userRef.kind === 'new') {
      newUserPaths.set(item.row.employeeNo, [
        ...(newUserPaths.get(item.row.employeeNo) ?? []),
        pathLabel,
      ]);
    }
  }

  const preview: OrgImportPreview = {
    newUsers: createUsers.map((user) => ({
      employeeNo: user.employeeNo,
      name: user.name,
      nodePaths: [...new Set(newUserPaths.get(user.employeeNo) ?? [])],
    })),
    renamedUsers,
    newAssignments,
    newNodes,
    renamedNodes,
    ownerChanges,
    ignoredRows: ignored,
    errors: [],
  };

  return {
    preview,
    createNodes,
    createUsers,
    renameUsers,
    renameNodes,
    createAssignments,
    setOwners,
  };
}

/** 名字集合里是否含两个以上不同的部门名(组的键带了 `\u0000`,需先拆开)。 */
function departmentNamesConflict(distinctNames: ReadonlySet<string>): boolean {
  const departments = new Set<string>();
  for (const entry of distinctNames) departments.add(entry.split('\u0000')[0] ?? entry);
  return departments.size > 1;
}
