/**
 * 组织架构导入的纯逻辑单测。
 *
 * 重点不在"能不能跑通",而在三条性质:
 *   1. **下载模板后原样上传 = 零差异**(幂等)。这条一旦破了,管理员每次导入
 *      都会莫名其妙改掉一批东西,而他根本没表达过那些意思。
 *   2. **认不出的人/节点绝不自作主张**。参照物缺失时要么报错、要么保持原样,
 *      不能"猜一个"。
 *   3. **改名不会被当成新建** —— 这正是模板里那两列只读 ID 存在的理由。
 */

import { describe, expect, it } from 'vitest';

import {
  IMPORT_COLUMNS,
  type CurrentState,
  type RawRow,
  parseRows,
  planImport,
} from './import.core.js';

// ---------------------------------------------------------------- 构造工具

const columnOf = (key: (typeof IMPORT_COLUMNS)[number]['key']): number =>
  IMPORT_COLUMNS.findIndex((column) => column.key === key);

/** 按列名给一行赋值,不用的列留空。 */
function row(rowNumber: number, values: Partial<Record<string, string>>): RawRow {
  const cells: (string | null)[] = IMPORT_COLUMNS.map(() => null);
  for (const [key, value] of Object.entries(values)) {
    const index = columnOf(key as (typeof IMPORT_COLUMNS)[number]['key']);
    if (index >= 0) cells[index] = value ?? null;
  }
  return { rowNumber, values: cells };
}

const DEPT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const GHOST_ID = '99999999-9999-4999-8999-999999999999';

/**
 * 一份"现状":技术部(部长 王建国)→ 后端组(组长 李峰);陈默在组里。
 * 三人都有归属,三人名字与库一致 —— 也就是**模板下载下来会长这样**。
 */
function fixture(): CurrentState {
  return {
    nodes: [
      {
        id: DEPT_ID,
        title: '技术部',
        parentId: null,
        depth: 0,
        materializedPath: `/${DEPT_ID}`,
        ownerId: 'u-1',
      },
      {
        id: GROUP_ID,
        title: '后端组',
        parentId: DEPT_ID,
        depth: 1,
        materializedPath: `/${DEPT_ID}/${GROUP_ID}`,
        ownerId: 'u-2',
      },
    ],
    users: [
      { id: 'u-1', employeeNo: 'KC001', name: '王建国' },
      { id: 'u-2', employeeNo: 'KC002', name: '李峰' },
      { id: 'u-3', employeeNo: 'KC003', name: '陈默' },
    ],
    assignments: [
      { userId: 'u-1', nodeId: DEPT_ID },
      { userId: 'u-2', nodeId: GROUP_ID },
      { userId: 'u-3', nodeId: GROUP_ID },
    ],
  };
}

/** 模板会为上面那份现状生成的三行。 */
const TEMPLATE_ROWS: RawRow[] = [
  row(2, {
    employeeNo: 'KC001',
    name: '王建国',
    department: '技术部',
    isOwner: '是',
    departmentId: DEPT_ID,
  }),
  row(3, {
    employeeNo: 'KC002',
    name: '李峰',
    department: '技术部',
    group: '后端组',
    isOwner: '是',
    departmentId: DEPT_ID,
    groupId: GROUP_ID,
  }),
  row(4, {
    employeeNo: 'KC003',
    name: '陈默',
    department: '技术部',
    group: '后端组',
    departmentId: DEPT_ID,
    groupId: GROUP_ID,
  }),
];

const none = { nodes: [], users: [], assignments: [] } satisfies CurrentState;

// ---------------------------------------------------------------- 解析

describe('parseRows —— 行级校验', () => {
  it('整行全空静默跳过(Excel 尾部常有成百上千个空行)', () => {
    const result = parseRows([row(2, {}), row(3, { employeeNo: 'KC001' })]);
    // 第 2 行全空 → 连"被忽略"都不报,报了只会把真问题淹掉
    expect(result.errors.map((issue) => issue.row)).toEqual([3]);
    expect(result.ignored).toHaveLength(0);
    expect(result.rows).toHaveLength(0);
  });

  it('缺必填项时明确指出缺哪一项', () => {
    const result = parseRows([row(5, { employeeNo: 'KC001' })]);
    expect(result.errors[0]?.reason).toContain('姓名不能为空');
    expect(result.errors[0]?.reason).toContain('部门不能为空');
  });

  it('工号格式不对时拦下来 —— 工号是登录标识,不能含糊', () => {
    expect(parseRows([row(2, { employeeNo: '-bad', name: 'A', department: 'D' })]).errors).toHaveLength(1);
    expect(parseRows([row(2, { employeeNo: 'a b', name: 'A', department: 'D' })]).errors).toHaveLength(1);
    // 带字母前缀与前导零是正常工号
    expect(parseRows([row(2, { employeeNo: 'KC2026007', name: 'A', department: 'D' })]).errors).toHaveLength(0);
  });

  it('同一工号两个姓名 → 报错,而不是悄悄改掉某个人的名字', () => {
    const result = parseRows([
      row(2, { employeeNo: 'KC001', name: '王建国', department: '技术部' }),
      row(3, { employeeNo: 'KC001', name: '王建军', department: '技术部' }),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toContain('KC001');
    expect(result.errors[0]?.reason).toContain('第 2 行');
  });

  it('同一人同一节点的重复行 → 记为忽略(幂等),不算错误', () => {
    const result = parseRows([
      row(2, { employeeNo: 'KC001', name: '王建国', department: '技术部' }),
      row(3, { employeeNo: 'KC001', name: '王建国', department: '技术部' }),
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.ignored[0]?.row).toBe(3);
  });

  it('同一人在**不同**节点各一行是正常的(多归属)', () => {
    const result = parseRows([
      row(2, { employeeNo: 'KC003', name: '陈默', department: '技术部', group: '后端组' }),
      row(3, { employeeNo: 'KC003', name: '陈默', department: '技术部', group: 'CRM 项目' }),
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it('ID 列被手工改坏时拦下来 —— 那两列不该被人碰', () => {
    const result = parseRows([
      row(2, { employeeNo: 'KC001', name: 'A', department: 'D', departmentId: 'not-a-uuid' }),
    ]);
    expect(result.errors[0]?.reason).toContain('部门ID');
  });

  it('「负责人」接受几种常见写法', () => {
    const marks = ['是', 'Y', 'yes', 'TRUE', '1'];
    for (const mark of marks) {
      const result = parseRows([
        row(2, { employeeNo: 'KC001', name: 'A', department: 'D', isOwner: mark }),
      ]);
      expect(result.rows[0]?.isOwner).toBe(true);
    }
    const noResult = parseRows([
      row(2, { employeeNo: 'KC001', name: 'A', department: 'D', isOwner: '否' }),
    ]);
    expect(noResult.rows[0]?.isOwner).toBe(false);
  });
});

// ---------------------------------------------------------------- 关键性质

describe('planImport —— 幂等(这条性质最重要)', () => {
  it('下载模板后原样上传 = 零差异', () => {
    const plan = planImport(parseRows(TEMPLATE_ROWS).rows, fixture());

    expect(plan.preview.errors).toHaveLength(0);
    expect(plan.createNodes).toHaveLength(0);
    expect(plan.createUsers).toHaveLength(0);
    expect(plan.createAssignments).toHaveLength(0);
    expect(plan.setOwners).toHaveLength(0);
    expect(plan.renameNodes).toHaveLength(0);
    expect(plan.renameUsers).toHaveLength(0);
    expect(plan.preview.newNodes).toHaveLength(0);
    expect(plan.preview.ownerChanges).toHaveLength(0);
  });

  it('成员里没有部长时,模板不会伪造他的行;原样上传仍然零差异', () => {
    // 现实里很常见:部长不是本部门的归属成员,于是模板里没有他那一行。
    // 若把"没写负责人"当成"要清空所有者",这里就会出问题。
    const state = fixture();
    const departmentOnlyMembers = {
      ...state,
      assignments: state.assignments.filter((item) => item.userId !== 'u-1'),
    };
    const rowsWithoutOwner = TEMPLATE_ROWS.filter((_, index) => index !== 0);

    const plan = planImport(parseRows(rowsWithoutOwner).rows, departmentOnlyMembers);

    expect(plan.preview.errors).toHaveLength(0);
    expect(plan.setOwners).toHaveLength(0);
    expect(plan.createNodes).toHaveLength(0);
  });
});

describe('planImport —— 新建', () => {
  it('空库:一行「部门 + 负责人」就能建出部门', () => {
    const plan = planImport(
      parseRows([row(2, { employeeNo: 'KC001', name: '王建国', department: '技术部', isOwner: '是' })]).rows,
      none,
    );

    expect(plan.preview.errors).toHaveLength(0);
    expect(plan.createNodes).toEqual([
      {
        key: 'd:技术部',
        name: '技术部',
        parentKey: null,
        parentId: null,
        depth: 0,
        ownerEmployeeNo: 'KC001',
      },
    ]);
    expect(plan.createUsers).toEqual([{ employeeNo: 'KC001', name: '王建国' }]);
    expect(plan.createAssignments).toHaveLength(1);
    expect(plan.preview.newNodes).toEqual([{ path: '技术部' }]);
    expect(plan.preview.newUsers[0]?.nodePaths).toEqual(['技术部']);
  });

  it('新建部门没有负责人 → 报错(否则那个部门没人能管)', () => {
    const plan = planImport(
      parseRows([row(2, { employeeNo: 'KC001', name: '王建国', department: '技术部' })]).rows,
      none,
    );
    expect(plan.preview.errors[0]?.reason).toContain('必须有一行「负责人」为是');
    // 有错时不出 ops —— 给出一份"看起来能导"的计划比报错更危险
    expect(plan.createNodes).toHaveLength(0);
  });

  it('同一部门两行负责人 → 报错(谁说了算没定,不能猜)', () => {
    const plan = planImport(
      parseRows([
        row(2, { employeeNo: 'KC001', name: 'A', department: '技术部', isOwner: '是' }),
        row(3, { employeeNo: 'KC002', name: 'B', department: '技术部', isOwner: '是' }),
      ]).rows,
      none,
    );
    expect(plan.preview.errors[0]?.reason).toContain('多个负责人');
  });

  it('组挂在部门下,并且父先于子', () => {
    const plan = planImport(
      parseRows([
        row(2, { employeeNo: 'KC001', name: 'A', department: '技术部', isOwner: '是' }),
        row(3, { employeeNo: 'KC002', name: 'B', department: '技术部', group: '后端组', isOwner: '是' }),
      ]).rows,
      none,
    );

    expect(plan.createNodes.map((node) => node.depth)).toEqual([0, 1]);
    expect(plan.createNodes[1]).toMatchObject({
      key: 'g:d:技术部/后端组',
      name: '后端组',
      parentKey: 'd:技术部',
      parentId: null,
      depth: 1,
      ownerEmployeeNo: 'KC002',
    });
    expect(plan.preview.newNodes).toEqual([{ path: '技术部' }, { path: '技术部 / 后端组' }]);
  });

  it('组没写负责人时由部门负责人兼(部长的权限本来就覆盖整棵子树)', () => {
    const plan = planImport(
      parseRows([
        row(2, { employeeNo: 'KC001', name: 'A', department: '技术部', isOwner: '是' }),
        row(3, { employeeNo: 'KC002', name: 'B', department: '技术部', group: '后端组' }),
      ]).rows,
      none,
    );
    expect(plan.createNodes[1]?.ownerEmployeeNo).toBe('KC001');
  });
});

describe('planImport —— 改名不会被当成新建', () => {
  it('部门改名:ID 对得上 → 识别成改名,不新建', () => {
    const rows = [
      row(2, {
        employeeNo: 'KC001',
        name: '王建国',
        department: '技术中心',
        isOwner: '是',
        departmentId: DEPT_ID,
      }),
      row(3, {
        employeeNo: 'KC002',
        name: '李峰',
        department: '技术中心',
        group: '后端组',
        isOwner: '是',
        departmentId: DEPT_ID,
        groupId: GROUP_ID,
      }),
      row(4, {
        employeeNo: 'KC003',
        name: '陈默',
        department: '技术中心',
        group: '后端组',
        departmentId: DEPT_ID,
        groupId: GROUP_ID,
      }),
    ];

    const plan = planImport(parseRows(rows).rows, fixture());

    expect(plan.preview.errors).toHaveLength(0);
    // 关键:**没有新建**。若只按名字匹配,这里会自动建出一个重复的「技术中心」,
    // 而旧的「技术部」连同文件都还在。
    expect(plan.createNodes).toHaveLength(0);
    expect(plan.preview.newNodes).toHaveLength(0);
    expect(plan.renameNodes).toEqual([{ nodeId: DEPT_ID, from: '技术部', to: '技术中心' }]);
    expect(plan.preview.renamedNodes[0]).toMatchObject({ from: '技术部', to: '技术中心' });
  });

  it('部门 ID 指向一个系统里没有的节点 → 报错,而不是新建一个同名的', () => {
    const plan = planImport(
      parseRows([
        row(2, {
          employeeNo: 'KC001',
          name: '王建国',
          department: '技术部',
          isOwner: '是',
          departmentId: GHOST_ID,
        }),
      ]).rows,
      fixture(),
    );
    expect(plan.preview.errors[0]?.reason).toContain('不存在');
    expect(plan.createNodes).toHaveLength(0);
  });

  it('组的 ID 不在这一行的部门下 → 报错(表格自相矛盾)', () => {
    const otherDeptId = '33333333-3333-4333-8333-333333333333';
    const state: CurrentState = {
      ...fixture(),
      nodes: [
        ...fixture().nodes,
        {
          id: otherDeptId,
          title: '市场部',
          parentId: null,
          depth: 0,
          materializedPath: `/${otherDeptId}`,
          ownerId: 'u-1',
        },
      ],
    };

    const plan = planImport(
      parseRows([
        row(2, {
          employeeNo: 'KC003',
          name: '陈默',
          department: '市场部',
          group: '后端组',
          departmentId: otherDeptId,
          groupId: GROUP_ID,
        }),
      ]).rows,
      state,
    );
    expect(plan.preview.errors[0]?.reason).toContain('不在部门');
  });
});

describe('planImport —— 增量语义', () => {
  it('表格里没出现的人与节点完全不动', () => {
    const plan = planImport(
      parseRows([
        row(2, {
          employeeNo: 'KC004',
          name: '赵敏',
          department: '技术部',
          group: '后端组',
          departmentId: DEPT_ID,
          groupId: GROUP_ID,
        }),
      ]).rows,
      fixture(),
    );

    expect(plan.preview.errors).toHaveLength(0);
    // 只加一条归属,不删任何人、不改所有者
    expect(plan.createAssignments).toEqual([
      { user: { kind: 'new', employeeNo: 'KC004' }, node: { kind: 'existing', id: GROUP_ID } },
    ]);
    expect(plan.createUsers).toEqual([{ employeeNo: 'KC004', name: '赵敏' }]);
    expect(plan.setOwners).toHaveLength(0);
    expect(plan.createNodes).toHaveLength(0);
  });

  it('已有的归属不重复写(幂等)', () => {
    const plan = planImport(parseRows(TEMPLATE_ROWS).rows, fixture());
    expect(plan.createAssignments).toHaveLength(0);
  });

  it('姓名与库里不一致 → 以表格为准(改名是常事)', () => {
    const rows = TEMPLATE_ROWS.map((source, index) =>
      index === 2 ? row(4, { ...{}, employeeNo: 'KC003', name: '陈默默', department: '技术部', group: '后端组', departmentId: DEPT_ID, groupId: GROUP_ID }) : source,
    );

    const plan = planImport(parseRows(rows).rows, fixture());

    expect(plan.renameUsers).toEqual([
      { userId: 'u-3', employeeNo: 'KC003', from: '陈默', to: '陈默默' },
    ]);
    expect(plan.preview.renamedUsers).toEqual([
      { employeeNo: 'KC003', from: '陈默', to: '陈默默' },
    ]);
  });

  it('换组长:显式写了负责人就改', () => {
    const rows = TEMPLATE_ROWS.map((source, index) =>
      index === 1
        ? row(3, {
            employeeNo: 'KC003',
            name: '陈默',
            department: '技术部',
            group: '后端组',
            isOwner: '是',
            departmentId: DEPT_ID,
            groupId: GROUP_ID,
          })
        : index === 2
          ? row(4, {
              employeeNo: 'KC002',
              name: '李峰',
              department: '技术部',
              group: '后端组',
              departmentId: DEPT_ID,
              groupId: GROUP_ID,
            })
          : source,
    );

    const plan = planImport(parseRows(rows).rows, fixture());

    expect(plan.setOwners).toHaveLength(1);
    expect(plan.setOwners[0]).toMatchObject({
      nodeId: GROUP_ID,
      owner: { kind: 'existing', id: 'u-3' },
      ownerName: '陈默',
    });
    expect(plan.preview.ownerChanges[0]).toMatchObject({ fromName: '李峰', toName: '陈默' });
  });

  it('新建的节点不出现在 setOwners 里(所有者随创建一起写)', () => {
    const plan = planImport(
      parseRows([
        row(2, { employeeNo: 'KC001', name: 'A', department: '新部门', isOwner: '是' }),
        row(3, { employeeNo: 'KC002', name: 'B', department: '新部门', group: '新组', isOwner: '是' }),
      ]).rows,
      none,
    );

    expect(plan.createNodes).toHaveLength(2);
    expect(plan.setOwners).toHaveLength(0);
    expect(plan.preview.ownerChanges).toHaveLength(0);
  });
});
