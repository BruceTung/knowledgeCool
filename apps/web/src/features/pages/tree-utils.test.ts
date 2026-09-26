/**
 * 页面树纯逻辑的测试。
 *
 * 重点是拖拽合法性判定:`isInsideSubtree` 与 `locateNode` 一起决定了
 * 「能不能往这里放」和「放下去会变成什么」。两者任一写错,
 * 结果都是树结构被悄悄弄坏,而界面上不会有任何报错。
 */
import type { PageNode } from '@knowledgecool/shared';
import { describe, expect, it } from 'vitest';

import {
  countPages,
  defaultExpandedIds,
  expandedIdsFor,
  findNode,
  isInsideSubtree,
  locateNode,
} from './tree-utils';

/** 造一棵树: a ─┬ b ─┬ d
 *                    └ e
 *              └ c
 *            f
 */
function makeNode(id: string, depth: number, children: PageNode[] = []): PageNode {
  return {
    id,
    parentId: depth === 0 ? null : 'parent',
    title: id,
    position: 0,
    depth,
    status: 'published',
    version: 1,
    children,
  };
}

const TREE: PageNode[] = [
  makeNode('a', 0, [
    makeNode('b', 1, [makeNode('d', 2), makeNode('e', 2)]),
    makeNode('c', 1),
  ]),
  makeNode('f', 0),
];

describe('findNode', () => {
  it('能找到任意深度的节点', () => {
    expect(findNode(TREE, 'd')?.id).toBe('d');
    expect(findNode(TREE, 'f')?.id).toBe('f');
  });

  it('找不到返回 undefined', () => {
    expect(findNode(TREE, 'nope')).toBeUndefined();
  });
});

describe('isInsideSubtree —— 拖拽防环的唯一判据', () => {
  it('子孙返回 true(直接子)', () => {
    expect(isInsideSubtree(TREE, 'a', 'b')).toBe(true);
  });

  it('子孙返回 true(隔了一层)', () => {
    expect(isInsideSubtree(TREE, 'a', 'd')).toBe(true);
  });

  it('不含自身 —— 自身相等由调用方单独判', () => {
    expect(isInsideSubtree(TREE, 'a', 'a')).toBe(false);
  });

  it('兄弟返回 false', () => {
    expect(isInsideSubtree(TREE, 'b', 'c')).toBe(false);
    expect(isInsideSubtree(TREE, 'c', 'b')).toBe(false);
  });

  it('祖先对子孙方向是单向的:反过来不成立', () => {
    expect(isInsideSubtree(TREE, 'd', 'a')).toBe(false);
  });

  it('不同分支返回 false', () => {
    expect(isInsideSubtree(TREE, 'b', 'f')).toBe(false);
  });
});

describe('locateNode —— 把「放在某节点前后」翻译成「目标父 + 下标」', () => {
  it('根节点:父为 null,下标正确', () => {
    expect(locateNode(TREE, 'a')).toEqual({ parentId: null, index: 0 });
    expect(locateNode(TREE, 'f')).toEqual({ parentId: null, index: 1 });
  });

  it('深层节点:父是该层的直接父', () => {
    expect(locateNode(TREE, 'e')).toEqual({ parentId: 'b', index: 1 });
    expect(locateNode(TREE, 'd')).toEqual({ parentId: 'b', index: 0 });
  });

  it('找不到返回 undefined', () => {
    expect(locateNode(TREE, 'nope')).toBeUndefined();
  });
});

describe('defaultExpandedIds', () => {
  it('只自动展开前两层里有子节点的', () => {
    // a 在 depth 0 且有子 → 展开;b 在 depth 1 且有子 → 展开;d/e 无子 → 不进
    expect(defaultExpandedIds(TREE).sort()).toEqual(['a', 'b']);
  });

  it('叶子不进列表', () => {
    expect(defaultExpandedIds([makeNode('leaf', 0)])).toEqual([]);
  });
});

describe('expandedIdsFor —— 从别处跳进来时展开整条路径', () => {
  it('返回到达目标所需的全部祖先', () => {
    expect(expandedIdsFor(TREE, 'd').sort()).toEqual(['a', 'b']);
  });

  it('目标是根节点时返回空(它本来就可见)', () => {
    expect(expandedIdsFor(TREE, 'a')).toEqual([]);
  });

  it('目标不存在时返回空,不抛错', () => {
    expect(expandedIdsFor(TREE, 'nope')).toEqual([]);
  });
});

describe('countPages', () => {
  it('统计全树节点数', () => {
    expect(countPages(TREE)).toBe(6);
    expect(countPages([])).toBe(0);
  });
});
