/**
 * 组织树**单行的视觉规格** —— 从 `OrgTreePanel.tsx` 抽出来的(v5.43,P1-1)。
 *
 * ## 为什么要抽
 *
 * 这些数字是**一组耦合的量**:改任何一个,其余都要跟着动,而它们原先散在
 * 组件 JSX 的 `style` 与 `className` 里,靠注释维系关系。真正被咬过的有:
 *
 *   · 缩进步长 12 → 16(箭头从 24px 放大到 28px)之后,引导线的 `left`
 *     必须同步,否则整列竖线系统性偏几个像素 —— **而且没人知道该改哪边**;
 *   · 叶子节点那个占位块必须与展开箭头**同宽**(都是 28px),
 *     否则同一列的徽章会参差不齐,整列看上去是歪的;
 *   · 点击区从 24px 放到 28px 时,行高也要一起动。
 *
 * 所以这里把它们收成一处,并在类型层面把"必须一起改"这件事写出来。
 *
 * ## 为什么不把 `renderNode` 整个抽成组件
 *
 * 试过,它需要传约二十个 props(节点状态 + 七个 setter + 六个判定函数),
 * 抽完之后签名比原函数**更难读**,而且那些 setter 全是父组件的 —
 * 拆了只是把耦合从文件内搬到文件间。
 *
 * 真正值得抽的是**这一层**:纯计算、零 React、可单独核对。
 * 组件的 JSX 留在原处,因为它的行文本就属于那个组件。
 */

import { T_NAV } from '../../lib/typography';
import { type OrgTreeNode } from './tree-utils.js';

/**
 * 缩进步长与引导线位置 —— **一组数,改一个必须改另一个**。
 *
 * 算式(v2.17 定):箭头 28px 宽,占位从 `depth * STEP + BASE` 开始,
 * 于是箭头中心 = 缩进 + 14。引导线要落在**上一级箭头的中点**上,
 * 也就是 `BASE + 2 + level * STEP`。
 */
export const TREE_INDENT = {
  /** 每深一级的缩进(px)。与箭头尺寸配套,别单独改。 */
  step: 16,
  /** 最浅一级(部门)的缩进(px)。 */
  base: 4,
  /** 封顶层级。再深就推出可视区了,封顶比整行看不见好。 */
  maxDepth: 8,
} as const;

/** 一行的垂直内缩(px)。 */
export function treeIndentPx(depth: number): number {
  return Math.min(depth, TREE_INDENT.maxDepth) * TREE_INDENT.step + TREE_INDENT.base;
}

/**
 * 第 `level` 级祖先的层级引导线落在哪个 x(px)。
 *
 * ⚠️ 与 `treeIndentPx` 是**一组数**:它算的是「上一级展开箭头的正中」,
 * 所以箭头尺寸一变,这里必须跟着变。详见 TREE_INDENT 的注释。
 */
export function treeGuideLeftPx(level: number): number {
  return TREE_INDENT.base + 2 + level * TREE_INDENT.step;
}

/** 箭头 / 徽章那一格的正方形边长(px)。叶子占位块也用它,才能对齐。 */
export const TREE_TOGGLE_PX = 28;

/**
 * 展开 / 折叠箭头的**完整类名**。
 *
 * ⚠️ 不要在调用处用 `` `h-${…}` `` 之类拼 —— Tailwind 扫源码里的完整类名,
 * 拼出来的扫不到,构建不报错但样式静默失效。详见 TREE_ROW_HEIGHT_CLASS。
 * 改尺寸时这里与 TREE_TOGGLE_PX 一起改(前者给 Tailwind,后者给文档与断言)。
 */
export const TREE_TOGGLE_CLASS = 'h-7 w-7';

/** 行高(px)。v2.17 从 36 放到 44 —— 只放大字号而不放开行高,汉字会挤在一起。 */
export const TREE_ROW_H = 44;

/**
 * 行高的 **Tailwind 类名**,与 `TREE_ROW_H` 配对。
 *
 * ⚠️ 刻意写成字面量而**不是** `` `h-${TREE_ROW_H / 4}` ``:
 * Tailwind 靠**扫源码里的完整类名**生成 CSS,动态拼出来的 `h-11`
 * 在它眼里是 `h-${...}`,扫不到就**不会生成那条规则** ——
 * 表现是行高静默失效(回到内容高度),而构建**不报错**。
 *
 * 所以这里写死 `h-11`(11 × 4px = 44px),改的时候两处一起改。
 * `audit:docs` 的字号刻度检查管不到行高,这条只能靠注释守住。
 */
const TREE_ROW_HEIGHT_CLASS = 'h-11';

/** 行内操作按钮的统一规格。 */
export const ROW_ACTION_CLASS =
  `flex h-7 w-7 flex-none items-center justify-center rounded-md text-sm font-medium ` +
  `text-slate-400 transition-colors hover:bg-white/15 hover:text-white`;

/** 危险操作(删除)按钮 —— 与上面同尺寸,只换配色。 */
export const ROW_ACTION_DANGER_CLASS =
  `flex h-7 w-7 flex-none items-center justify-center rounded-md text-sm font-medium ` +
  `text-slate-400 transition-colors hover:bg-red-500/20 hover:text-red-300`;

/** 节点类型的中文短标:部 / 组 / 页。 */
export function kindBadge(node: OrgTreeNode): string {
  if (node.depth === 0) return '部';
  if (node.kind === 'space') return '组';
  return '页';
}

/**
 * 状态徽章的类名 —— 三档。
 *
 * v2.17:深底上的配色改成「半透明底 + 浅色字 + 细描边」。
 * 原来那种 `bg-blue-50`(接近纯白)在深色树里是一块刺眼的小白点。
 *
 * ⚠️ 第三档(页面)刻意**不带 ring** —— 它是最多的一档,
 * 满树都是,加了描边会变成一片密密的框,反而更吵。
 */
export function kindBadgeClass(node: OrgTreeNode): string {
  if (node.depth === 0) return 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30';
  if (node.kind === 'space') return 'bg-teal-500/20 text-teal-200 ring-1 ring-teal-400/30';
  return 'bg-white/10 text-slate-300';
}

/** 徽章那一格的正方形边长(px)。24px,与 TREE_TOGGLE_PX(28px)不同档。 */
export const TREE_BADGE_PX = 24;

/**
 * 徽章的**类名**,与 `TREE_BADGE_PX` 配对。
 * ⚠️ 同样是字面量 —— 动态拼出来的 `h-6` 扫不到,构建不报错但样式失效。
 * 详见 TREE_ROW_HEIGHT_CLASS 的说明。
 */
export const TREE_BADGE_CLASS = 'h-6 w-6';

/** 一行的类名。选中态走 CSS 类(青色指示条 + 由内向外渐隐),不用纯色块。 */
export function treeRowClass(options: {
  isActive: boolean;
  dragging: boolean;
  forbidden: boolean;
  dropZone: 'before' | 'into' | 'after' | null;
}): string {
  return [
    'group relative flex items-center gap-2 rounded-lg pr-2 transition-colors',
    TREE_ROW_HEIGHT_CLASS,
    // ⚠️ T_NAV 是**内容档**(16px/20px)—— 树行是"要被读"的内容,
    // 不是标签。漏掉它会让这一行退回继承的字号。
    T_NAV,
    options.isActive ? 'kc-tree-active' : 'text-slate-300 hover:bg-white/10',
    options.forbidden && options.dragging ? 'opacity-40' : '',
    options.dropZone === 'into' ? 'ring-2 ring-sky-400' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}
