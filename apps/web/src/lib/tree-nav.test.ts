/**
 * 组织树键盘导航的纯逻辑测试(v2.14)。
 *
 * ## 为什么这一组值得写
 *
 * 方向键的 bug **不会报错**,只表现为「按了没反应」或「跳到奇怪的地方」。
 * 而键盘用户(以及用屏幕阅读器的同事)遇到这种情况通常以为自己操作不对,
 * 不会提 bug —— 于是这类缺陷可以存在很久没人知道。
 *
 * 这里钉四件事:上下移动只走**可见**节点、右进左出、Home/End、
 * 以及「← 是唯一的出路」这一条。
 */
import { describe, expect, it } from 'vitest';

import { resolveTreeKey, treeOrder, type TreeNavNode } from './tree-nav';

function node(id: string, children: TreeNavNode[] = []): TreeNavNode {
  return { id, children };
}

/** 技术部 ─ { 后端组 ─ { 接口规范 }, CRM 项目 };市场部 */
function fixture(): TreeNavNode[] {
  const api = node('doc-api');
  const group = node('grp-be', [api]);
  const crm = node('grp-crm');
  const tech = node('dept-tech', [group, crm]);
  const mkt = node('dept-mkt');
  return [tech, mkt];
}

const ALL_OPEN = (): boolean => true;
const ALL_CLOSED = (): boolean => false;

describe('treeOrder —— 可见顺序', () => {
  it('全部展开时按深度优先自上而下', () => {
    expect(treeOrder(fixture(), ALL_OPEN).ids).toEqual([
      'dept-tech',
      'grp-be',
      'doc-api',
      'grp-crm',
      'dept-mkt',
    ]);
  });

  it('★ 折叠起来的分支不进入可见顺序', () => {
    // 这正是「按了上下键好像没反应」的根因:焦点走到了折叠分支里的节点,
    // 屏幕上什么都没有变化,屏幕阅读器也念不出任何东西。
    expect(treeOrder(fixture(), ALL_CLOSED).ids).toEqual(['dept-tech', 'dept-mkt']);
  });

  it('父节点表指向直接父节点,根节点不在表里', () => {
    const { parentOf } = treeOrder(fixture(), ALL_OPEN);
    expect(parentOf.get('grp-be')).toBe('dept-tech');
    expect(parentOf.get('doc-api')).toBe('grp-be');
    expect(parentOf.get('dept-tech')).toBeUndefined();
  });
});

describe('resolveTreeKey —— 方向键', () => {
  const base = {
    nodeId: 'grp-be',
    childIds: ['doc-api'],
    visibleIds: ['dept-tech', 'grp-be', 'doc-api', 'grp-crm', 'dept-mkt'],
    parentId: 'dept-tech',
    isExpanded: true,
  };

  it('↓ 与 ↑ 移到可见顺序里的前后一个', () => {
    expect(resolveTreeKey({ ...base, key: 'ArrowDown' })).toEqual({
      type: 'move',
      to: 'doc-api',
    });
    expect(resolveTreeKey({ ...base, key: 'ArrowUp' })).toEqual({
      type: 'move',
      to: 'dept-tech',
    });
  });

  it('★ → 在折叠时展开,而不是移动', () => {
    expect(resolveTreeKey({ ...base, key: 'ArrowRight', isExpanded: false })).toEqual({
      type: 'expand',
      id: 'grp-be',
    });
  });

  it('★ → 在已展开时进第一个子节点(不是"下一个可见节点")', () => {
    // 两者在子节点也展开时不同:下一个可见节点可能是子节点的子节点,
    // 用错了会让 → 跳过一整层。
    expect(resolveTreeKey({ ...base, key: 'ArrowRight' })).toEqual({
      type: 'move',
      to: 'doc-api',
    });
  });

  it('★ ← 已展开时折叠,已折叠时回父节点', () => {
    expect(resolveTreeKey({ ...base, key: 'ArrowLeft', isExpanded: true })).toEqual({
      type: 'collapse',
      id: 'grp-be',
    });
    expect(resolveTreeKey({ ...base, key: 'ArrowLeft', isExpanded: false })).toEqual({
      type: 'move',
      to: 'dept-tech',
    });
  });

  it('★ 根节点按 ← 时若已展开 → 先折叠它(W3C APG:Left 在展开节点上就是折叠)', () => {
    // 我第一版断言这里是 none —— 那是我按「根节点没有父节点」想当然推的,
    // 而规范里 Left 的第一件事是"若展开则折叠"。实现是对的,断言是错的。
    expect(
      resolveTreeKey({
        key: 'ArrowLeft',
        nodeId: 'dept-tech',
        childIds: ['grp-be', 'grp-crm'],
        visibleIds: base.visibleIds,
        parentId: undefined,
        isExpanded: true,
      }),
    ).toEqual({ type: 'collapse', id: 'dept-tech' });
  });

  it('★★ 根节点已折叠时按 ← → 什么都不做(不能把焦点丢到 undefined)', () => {
    // 这才是危险的那一格:没有父节点可回,而它本身也没展开。
    // 少了这个保护,焦点会跑到 undefined —— 表现是焦点**丢到 body 上**,
    // 接下来按 Tab 会从页面开头重新走一遍,用户会完全迷路。
    expect(
      resolveTreeKey({
        key: 'ArrowLeft',
        nodeId: 'dept-tech',
        childIds: ['grp-be', 'grp-crm'],
        visibleIds: base.visibleIds,
        parentId: undefined,
        isExpanded: false,
      }),
    ).toEqual({ type: 'none' });
  });
  it('叶子节点按 → 什么都不做', () => {
    expect(
      resolveTreeKey({ ...base, key: 'ArrowRight', nodeId: 'dept-mkt', childIds: [], isExpanded: false }),
    ).toEqual({ type: 'none' });
  });

  it('叶子节点按 ← 回父节点', () => {
    // 同样:doc-api 的父是 grp-be。第一版漏改了 parentId,于是实现
    // **忠实地**返回了我给的那个错误父节点。
    expect(
      resolveTreeKey({
        ...base,
        key: 'ArrowLeft',
        nodeId: 'doc-api',
        childIds: [],
        parentId: 'grp-be',
        isExpanded: false,
      }),
    ).toEqual({ type: 'move', to: 'grp-be' });
  });

  it('末个节点按 ↓ / 首个节点按 ↑ → to 为 undefined(组件据此不动)', () => {
    expect(resolveTreeKey({ ...base, key: 'ArrowDown', nodeId: 'dept-mkt' })).toEqual({
      type: 'move',
      to: undefined,
    });
    expect(resolveTreeKey({ ...base, key: 'ArrowUp', nodeId: 'dept-tech' })).toEqual({
      type: 'move',
      to: undefined,
    });
  });

  it('Home / End 到首尾', () => {
    expect(resolveTreeKey({ ...base, key: 'Home' })).toEqual({ type: 'move', to: 'dept-tech' });
    expect(resolveTreeKey({ ...base, key: 'End' })).toEqual({ type: 'move', to: 'dept-mkt' });
  });

  it('Enter 打开当前节点', () => {
    expect(resolveTreeKey({ ...base, key: 'Enter' })).toEqual({ type: 'open', id: 'grp-be' });
  });

  it('其它按键一律 none(不吞掉浏览器与输入法的按键)', () => {
    for (const key of ['a', 'Tab', 'Escape', 'F5', 'Shift']) {
      expect(resolveTreeKey({ ...base, key })).toEqual({ type: 'none' });
    }
  });
});
