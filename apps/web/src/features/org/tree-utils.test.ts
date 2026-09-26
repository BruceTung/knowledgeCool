/**
 * 组织树纯逻辑单测。
 *
 * 重点在两个"错了不会立刻报错"的地方:
 *   1. **成环判定**。把父节点拖进自己的子孙会让物化路径成环,
 *      之后所有前缀查询都失效 —— 界面上只表现为「有时候拖不动」。
 *   2. **父节点缺失时的兜底**。服务端给的扁平列表里若有一个节点的父不在
 *      列表里,那种节点必须**浮到顶层**而不是消失 —— "东西不见了"
 *      比"位置不对"难查得多。
 */
import type { NodeSummary } from '@knowledgecool/shared';
import { describe, expect, it } from 'vitest';

import { buildTree, countNodes, findNode, isInsideSubtree, locateNode, subtreeSize } from './tree-utils';

function node(id: string, parentId: string | null, position: number, title = id): NodeSummary {
  return {
    id,
    parentId,
    kind: parentId === null ? 'space' : 'document',
    title,
    position,
    depth: parentId === null ? 0 : 1,
    status: 'published',
    version: 1,
    ownerId: 'u-1',
    ownerName: '某人',
    commentCount: 0,
  };
}

/** 技术部 ─ { 后端组 ─ { 接口规范 }, CRM 项目 };市场部(空)。 */
const FLAT: NodeSummary[] = [
  node('dept-tech', null, 0, '技术部'),
  node('dept-mkt', null, 1, '市场部'),
  node('grp-be', 'dept-tech', 0, '后端组'),
  node('grp-crm', 'dept-tech', 1, 'CRM 项目'),
  node('doc-api', 'grp-be', 0, '接口规范'),
];

describe('buildTree', () => {
  it('按父子关系重建嵌套,并按 position 排序', () => {
    const tree = buildTree(FLAT);
    expect(tree.map((n) => n.id)).toEqual(['dept-tech', 'dept-mkt']);
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['grp-be', 'grp-crm']);
    expect(tree[0]?.children[0]?.children.map((n) => n.id)).toEqual(['doc-api']);
  });

  it('position 相同则按标题排,结果稳定', () => {
    const tree = buildTree([node('a', null, 0, '乙'), node('b', null, 0, '甲')]);
    expect(tree.map((n) => n.title)).toEqual(['甲', '乙']);
  });

  it('⚠️ 父节点不在列表里时浮到顶层,而不是消失', () => {
    // 服务端按权限裁剪过、或数据异常时会出现这种输入。
    // 让那个节点消失的话,用户会看到"文档莫名不见了" —— 最难排查的一类问题。
    const tree = buildTree([node('orphan', 'not-in-list', 0, '孤儿节点')]);
    expect(tree.map((n) => n.id)).toEqual(['orphan']);
  });

  it('支持超过两层的嵌套(深度不设上限)', () => {
    const deep = [
      ...FLAT,
      node('sub-1', 'doc-api', 0, '子页面'),
      node('sub-2', 'sub-1', 0, '孙页面'),
    ];
    const tree = buildTree(deep);
    const api = findNode(tree, 'doc-api');
    expect(findNode(api?.children ?? [], 'sub-1')?.children[0]?.id).toBe('sub-2');
  });
});

describe('isInsideSubtree —— 拖拽防环', () => {
  const tree = buildTree(FLAT);

  it('子孙在里面,自己不在里面', () => {
    expect(isInsideSubtree(tree, 'dept-tech', 'doc-api')).toBe(true);
    expect(isInsideSubtree(tree, 'dept-tech', 'grp-be')).toBe(true);
    // 自身不算"在自己的子树内部" —— 自身相等由调用方单独判
    expect(isInsideSubtree(tree, 'dept-tech', 'dept-tech')).toBe(false);
  });

  it('别的分支不在里面', () => {
    expect(isInsideSubtree(tree, 'grp-be', 'grp-crm')).toBe(false);
    expect(isInsideSubtree(tree, 'dept-mkt', 'dept-tech')).toBe(false);
  });

  it('⚠️ 前缀相近的 id 不能误判(靠的是树结构不是字符串前缀)', () => {
    // 物化路径判定最容易在这类"前缀相同但不是一个分支"的 id 上出错,
    // 所以这里刻意用 id 相似的一对
    const tricky = buildTree([node('p-1', null, 0), node('p-10', null, 1)]);
    expect(isInsideSubtree(tricky, 'p-1', 'p-10')).toBe(false);
  });
});

describe('locateNode', () => {
  const tree = buildTree(FLAT);

  it('给出父与在兄弟中的下标', () => {
    expect(locateNode(tree, 'grp-crm')).toEqual({ parentId: 'dept-tech', index: 1 });
    expect(locateNode(tree, 'doc-api')).toEqual({ parentId: 'grp-be', index: 0 });
  });

  it('顶层节点的 parentId 是 null', () => {
    expect(locateNode(tree, 'dept-mkt')).toEqual({ parentId: null, index: 1 });
  });

  it('找不到时返回 undefined', () => {
    expect(locateNode(tree, 'nope')).toBeUndefined();
  });
});

describe('计数', () => {
  it('countNodes 与 subtreeSize', () => {
    const tree = buildTree(FLAT);
    expect(countNodes(tree)).toBe(5);
    const tech = findNode(tree, 'dept-tech');
    expect(tech === undefined ? 0 : subtreeSize(tech)).toBe(4);
  });
});
