/**
 * 组织树面板(DESIGN.md §7.2 的左侧栏)。
 *
 * ⚠️ 这是 v2.0 与前几版差别最大的界面:以前是"选了某个空间才出现一棵页面树",
 * 现在是**登录后直接看到整个公司的组织架构**,点开任意节点就是它的内容。
 *
 * 权限在这里**只用来决定显示什么**。服务端仍是唯一裁判:
 * 即使有人把按钮抠出来点,后端照样 403。
 * 前端判断用的是服务端算好的 `editableNodeIds` / `manageableNodeIds` ——
 * **不在前端重算一遍权限**(那必然与服务端漂移,而漂移的表现是
 * "按钮在但点了报错"或反之)。
 */
import type { MyScope, NodeTreeResponse } from '@knowledgecool/shared';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorNote } from '../../components/ui';
import { resolveTreeKey, treeOrder } from '../../lib/tree-nav';
import { T_BODY, T_LABEL, T_META } from '../../lib/typography';
import { useCreateNode, useDeleteNode, useMoveNode, useUpdateNode } from './queries';
import {
  buildTree,
  countNodes,
  defaultExpandedIds,
  expandedIdsFor,
  findNode,
  isInsideSubtree,
  locateNode,
  type OrgTreeNode,
} from './tree-utils';

/** 拖拽落点的三种语义:上四分之一=前,下四分之一=后,中间=成为子节点。 */
type DropZone = 'before' | 'into' | 'after';

interface OrgTreePanelProps {
  tree: NodeTreeResponse;
  /**
   * 超管对**一级部门**也有管理入口 —— 换部长只有他能做。
   * 服务端给的 `manageableNodeIds` 里不含他(他不是内容所有者),
   * 所以这一条得单独放行,否则"换部长"在界面上没有入口。
   */
  isSuperAdmin: boolean;
  /** 我的组织归属 —— 用来判断"我能在这里新建吗" */
  scopes: readonly MyScope[];
  /** 当前打开的节点,高亮并自动展开到它 */
  activeNodeId: string | undefined;
  onOpenGrants: (nodeId: string, title: string) => void;
  /** 成员弹窗(v2.4)—— 管组织归属,与权限弹窗是两个入口 */
  onOpenMembers: (nodeId: string, title: string) => void;
}

/** 节点类型的中文短标。 */
function kindBadge(node: OrgTreeNode): string {
  if (node.depth === 0) return '部';
  if (node.kind === 'space') return '组';
  return '页';
}

/**
 * 行内操作按钮的统一规格。
 *
 * ⚠️ 这几个按钮原来是**各写各的** —— 有的带 `text-xs`,有的不写
 * (于是继承父级的字号),于是一行里 6 个按钮出现两种字号。
 * 这就是「图标、字体大小、字样都不对称」最直接的来源(用户 2026-09-27 反馈)。
 *
 * v2.8:点击区 24px、字形跟着内容档(14px)。Atlassian 的规范里
 * "配合图标时用 Medium 字重",所以这里也给 `font-medium` —— 字形小、
 * 又细的时候,图标会显得脏。
 */
const ROW_ACTION_CLASS = `flex h-6 w-6 flex-none items-center justify-center rounded text-sm font-medium text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700`;
const ROW_ACTION_DANGER_CLASS = `flex h-6 w-6 flex-none items-center justify-center rounded text-sm font-medium text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600`;

export function OrgTreePanel({
  tree,
  scopes,
  isSuperAdmin,
  activeNodeId,
  onOpenGrants,
  onOpenMembers,
}: OrgTreePanelProps) {
  const navigate = useNavigate();
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const moveNode = useMoveNode();
  const deleteNode = useDeleteNode();

  const nodes = useMemo(() => buildTree(tree.nodes), [tree.nodes]);
  const editable = useMemo(() => new Set(tree.editableNodeIds), [tree.editableNodeIds]);
  const manageable = useMemo(() => new Set(tree.manageableNodeIds), [tree.manageableNodeIds]);

  /**
   * 展开状态用「派生 + 覆盖」而不是把最终结果存进 state。
   *
   * 自动展开的部分(部门层 + 当前节点所在路径)完全由数据算出来,
   * state 只存用户**手动改过**的节点。这样既不需要 effect(在 effect 里
   * 同步 setState 会触发级联渲染),树刷新后也不会出现莫名的开合跳变。
   */
  const autoExpanded = useMemo(() => {
    const ids = new Set(defaultExpandedIds(nodes));
    if (activeNodeId !== undefined) {
      for (const id of expandedIdsFor(nodes, activeNodeId)) ids.add(id);
    }
    return ids;
  }, [nodes, activeNodeId]);

  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: DropZone } | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);

  const isNodeExpanded = (id: string): boolean => overrides.get(id) ?? autoExpanded.has(id);

  const setExpandedState = (id: string, open: boolean): void => {
    setOverrides((prev) => new Map(prev).set(id, open));
  };

  // ---- 键盘可达性(v2.14) ----
  //
  // 此前每行都是 `tabIndex={0}`,于是一个 20 行的树要按 20 次 Tab 才能穿过去 ——
  // 而且带子节点的行**有两个 Tab 停留点**(整行一个、箭头按钮一个)。
  // ARIA tree 的标准做法是"漫游 tabindex":整棵树只有一个可 Tab 进入的点,
  // 进来之后用上下左右在树内移动。
  const [focusedId, setFocusedId] = useState<string | null>(null);

  /** 当前**可见**的节点顺序(展开的才算),键盘上下移动走的就是它。 */
  /*
    可见顺序与父节点表 —— 由 lib/tree-nav 的 treeOrder 算(纯函数,有单测)。
    内联在这里的话要连着 React 一起测,而那种测试没人会写。
  */
  const { ids: visibleIds, parentOf } = useMemo(
    () => treeOrder(nodes, (id) => overrides.get(id) ?? autoExpanded.has(id)),
    [nodes, overrides, autoExpanded],
  );
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  /** 移动焦点并同步漫游位置。用命令式 focus,因为要真的把光标交过去。 */
  const focusItem = (id: string | undefined): void => {
    if (id === undefined) return;
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  };

  /**
   * 树内的方向键。
   *
   * 与 ARIA 规范一致:右=展开(已展开则进第一个子节点),左=折叠(已折叠则回父节点)。
   * 少了"左回父节点"这一条,键盘用户进得去出不来 —— 只能一路 Tab 到页尾。
   */
  /**
   * 方向键 → 执行动作。**判断在 lib/tree-nav 的 resolveTreeKey 里**(纯函数,有单测),
   * 这里只负责"把动作做出来" —— 于是"按 ← 该去哪"这种问题可以在单测里回答,
   * 而不必开着浏览器按一遍。
   */
  const onTreeKeyDown = (event: React.KeyboardEvent, node: OrgTreeNode): void => {
    const action = resolveTreeKey({
      key: event.key,
      nodeId: node.id,
      childIds: node.children.map((child) => child.id),
      visibleIds,
      parentId: parentOf.get(node.id),
      isExpanded: isNodeExpanded(node.id),
    });

    if (action.type === 'none') return;
    // 只有真的处理了这个键才 preventDefault —— 否则会把浏览器与输入法的
    // 按键一起吞掉(比如 F5、Ctrl+F)。
    event.preventDefault();

    switch (action.type) {
      case 'move':
        focusItem(action.to);
        break;
      case 'expand':
        setExpandedState(action.id, true);
        break;
      case 'collapse':
        setExpandedState(action.id, false);
        break;
      case 'open':
        void navigate(`/n/${action.id}`);
        break;
      default:
        break;
    }
  };
  const toggleExpanded = (id: string): void => {
    setExpandedState(id, !isNodeExpanded(id));
  };

  /** 我的组织归属覆盖到的节点集合(含各自子树)。 */
  function assignedWithin(nodeId: string): boolean {
    return scopes.some((scope) => scope.nodeId === nodeId || isInsideSubtree(nodes, scope.nodeId, nodeId));
  }

  /**
   * 能在这一行下面新建吗?
   *
   * 与服务端 `requireCreateUnder` 同一套判据:能改这个节点,或归属在它范围内。
   * 这只是"要不要显示 + 号";真正的拒绝在服务端。
   */
  function canCreateUnder(node: OrgTreeNode): boolean {
    return editable.has(node.id) || assignedWithin(node.id);
  }

  function zoneFromEvent(event: DragEvent<HTMLElement>): DropZone {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    if (ratio < 0.28) return 'before';
    if (ratio > 0.72) return 'after';
    return 'into';
  }

  /** 拖到自己或自己的子孙上都是非法的 —— 会让树成环。 */
  function isForbiddenTarget(targetId: string): boolean {
    if (dragId === null) return true;
    if (dragId === targetId) return true;
    return isInsideSubtree(nodes, dragId, targetId);
  }

  function performMove(targetId: string, zone: DropZone): void {
    if (dragId === null) return;
    const dragged = findNode(nodes, dragId);
    if (dragged === undefined) return;

    let newParentId: string | null;
    let newPosition: number | undefined;

    if (zone === 'into') {
      newParentId = targetId;
      newPosition = undefined; // 追加到末尾
    } else {
      const location = locateNode(nodes, targetId);
      if (location === undefined) return;
      newParentId = location.parentId;
      newPosition = zone === 'before' ? location.index : location.index + 1;
    }

    // 原地没动就别发请求 —— 拖一下就产生一次写操作是没必要的
    const current = locateNode(nodes, dragged.id);
    if (
      current !== undefined &&
      newPosition !== undefined &&
      current.parentId === newParentId &&
      current.index === newPosition
    ) {
      return;
    }

    moveNode.mutate({
      nodeId: dragged.id,
      newParentId,
      version: dragged.version,
      ...(newPosition === undefined ? {} : { newPosition }),
    });
  }

  /**
   * 新建节点,并**就地**进入重命名态。
   *
   * ⚠️ v2.16 修的一处真实缺陷:原实现在 `onSuccess` 里同时
   * `setRenamingId(created.id)` 和 `navigate('/n/' + created.id)`。
   * 可是 `renamingId` 要生效必须等树刷新、那个 id 出现在 `tree.nodes` 里;
   * 而导航立刻切走路由,本组件(连同这份本地 state)当场被卸载 ——
   * 重命名态**从来没有被渲染过**。
   *
   * 表现:节点以服务端的默认名(`未命名页面` / `未命名空间`)留在库里,
   * 而用户以为自己刚才"命名过了" —— 回到树上只看到一排未命名项。
   *
   * 现在**不导航**:留在树上把名字改好。想打开它,点一下就是了
   * (重命名完成后用户本来也多半还要再建下一个)。
   */
  function handleCreate(parentId: string | null, kind: 'space' | 'document'): void {
    createNode.mutate(
      { parentId, kind },
      {
        onSuccess: (created) => {
          // 新建后保证父节点是展开的,否则新节点看不见
          if (parentId !== null) setExpandedState(parentId, true);
          // 只进重命名态,**不 navigate** —— 见上面的说明
          setRenamingId(created.id);
        },
      },
    );
  }

  function handleRename(node: OrgTreeNode, value: string): void {
    setRenamingId(null);
    const next = value.trim();
    if (next === '' || next === node.title) return;
    updateNode.mutate({ nodeId: node.id, title: next, version: node.version });
  }

  function handleDelete(node: OrgTreeNode): void {
    const size = countNodes([node]);
    const label = size > 1 ? `「${node.title}」及其下 ${String(size - 1)} 个节点` : `「${node.title}」`;
    // ⚠️ v2.12 起删除是**物理删除、不可恢复**,确认语必须说清后果。
    // 原来说的是"移入回收站"(可恢复),在回收站被移除之后那句话会骗人。
    if (!window.confirm(`确定删除 ${label}?\n\n此操作不可恢复,内容将永久丢失。`)) return;
    deleteNode.mutate(node.id);
  }

  function renderNode(node: OrgTreeNode) {
    const isExpanded = isNodeExpanded(node.id);
    const isActive = node.id === activeNodeId;
    const forbidden = dragId !== null && isForbiddenTarget(node.id);
    const target = dropTarget?.id === node.id ? dropTarget.zone : null;
    const nodeEditable = editable.has(node.id);
    const nodeManageable = manageable.has(node.id) || (isSuperAdmin && node.depth === 0);

    const rowClass = [
      // `h-9`(36px)配 14px 内容。Atlassian 的 `font.body` = 14/20,
      // 20px 行高的文字放进 36px 的行里,上下各留 8px —— 这是列表项的常规留白。
      `group relative flex h-9 items-center gap-1.5 rounded-md pr-1.5 ${T_BODY} transition-colors`,
      isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:bg-white',
      forbidden && dragId !== null ? 'opacity-40' : '',
      target === 'into' ? 'ring-2 ring-blue-400' : '',
    ].join(' ');

    return (
      /*
        ⚠️ `role="treeitem"` 放在 `<li>` 上,不是里面的 `<div>` 上。
        ARIA 要求 treeitem 是 `role="tree"`/`role="group"` 的**直接子元素**;
        此前它是 `<ul role="group"><li><div role="treeitem">`,中间隔了一个 `<li>`,
        屏幕阅读器读出来的层级是乱的(有时干脆不报"这是第几级")。
        子节点那个 `<ul role="group">` 也必须留在**这个 treeitem 内部** —— 它现在就是。
      */
      <li
        key={node.id}
        role="treeitem"
        ref={(element) => {
          if (element === null) itemRefs.current.delete(node.id);
          else itemRefs.current.set(node.id, element);
        }}
        aria-selected={isActive}
        // 有子节点才报展开状态。给叶子节点加 aria-expanded 是无效属性,
        // 屏幕阅读器会念出一个永远为 false 的"已折叠"。
        {...(node.children.length > 0 ? { 'aria-expanded': isExpanded } : {})}
        aria-level={node.depth + 1}
        // 漫游 tabindex:整棵树只有**一个**可 Tab 进入的点。
        // 未聚焦过时落在当前打开的那一篇上,否则落在第一个节点上。
        tabIndex={focusedId === node.id || (focusedId === null && isActive) ? 0 : -1}
        onFocus={() => {
          setFocusedId(node.id);
        }}
        onKeyDown={(event) => {
          onTreeKeyDown(event, node);
        }}
      >
        <div
          draggable={nodeEditable && renamingId !== node.id}
          className={rowClass}
          style={{
            // ⚠️ 缩进必须**跟着 depth 走**。
            //
            // 原来这里写的是 `(node.depth > 2 ? 2 : node.depth) * 12 + 4` ——
            // depth 超过 2 就被钳成 2,于是「第三级组下面的页面」与它的父节点
            // 缩进完全相同,一列看下去看不出谁属于谁(用户 2026-09-27 反馈)。
            // 现在只在一个很深的层级封顶,纯粹是为了防止整行被推到看不见。
            //
            // 常数 4 是**跟着箭头宽度走的**(v2.9):箭头 24px 时 `4 + 12 = 16`,
            // 正好等于下面引导线的落点 —— 所以放大点击区**没有**让整列的
            // 竖线错位,也没有让徽章、标题往右挪。
            paddingLeft: `${String(Math.min(node.depth, 8) * 13 + 4)}px`,
          }}
          onClick={() => void navigate(`/n/${node.id}`)}
          onDragStart={(event) => {
            setDragId(node.id);
            event.dataTransfer.effectAllowed = 'move';
            // Firefox 必须 setData 才会真正开始拖拽
            event.dataTransfer.setData('text/plain', node.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropTarget(null);
            setRootDropActive(false);
          }}
          onDragOver={(event) => {
            if (dragId === null || isForbiddenTarget(node.id)) return; // 不 preventDefault = 不可放置
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const zone = zoneFromEvent(event);
            setDropTarget((prev) =>
              prev?.id === node.id && prev.zone === zone ? prev : { id: node.id, zone },
            );
          }}
          onDragLeave={() => {
            setDropTarget((prev) => (prev?.id === node.id ? null : prev));
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragId === null || isForbiddenTarget(node.id)) return;
            const zone = zoneFromEvent(event);
            setDragId(null);
            setDropTarget(null);
            performMove(node.id, zone);
          }}
        >
          {target === 'before' && (
            <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded bg-blue-500" />
          )}
          {target === 'after' && (
            <span className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded bg-blue-500" />
          )}

          {/*
            层级引导线(v2.8)。

            ⚠️ 只有缩进是不够的:第三级以下,"这个页面属于哪个组"要靠数像素去猜 ——
            用户在最早的反馈里就说过「第三级组下面的页面没有缩进了,这样看不到递进关系」。
            Confluence 与 Notion 都用这种细竖线把层级**画**出来,而不是让人去算。

            位置:第 i 级祖先的引导线落在 `16 + i*13`。
            缩进公式是 `depth*13 + 4`,箭头占 24px,**`+12` 正好是箭头的中心** ——
            所以竖线看起来是从上一级的展开箭头正中延伸下来的。
            用 `inset-y-0` 让它在相邻行之间连成一条,而不是一段一段的。
          */}
          {Array.from({ length: Math.min(node.depth, 8) }, (_, level) => (
            <span
              key={`guide-${String(level)}`}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-slate-200"
              style={{ left: `${String(16 + level * 13)}px` }}
            />
          ))}

          {node.children.length > 0 ? (
            /*
              ⚠️ 这里刻意**不是** <button>(v2.14)。

              它嵌在 role="treeitem" 里面 —— 交互元素嵌套在 treeitem 里会让
              屏幕阅读器困惑(念出一个可点的东西,却不知道它在树上哪个位置),
              而且那一行会因此有**两个 Tab 停留点**。

              现在它是 aria-hidden 的装饰元素:
                · 键盘用户走左右方向键展开 / 折叠(见 onTreeKeyDown)
                · 鼠标用户照旧点它
              下面这段尺寸与点击区的说明仍然有效(它是鼠标的瞄准目标)。
            */
            <span
              aria-hidden
              /*
                展开 / 折叠。

                ⚠️ v2.9 改了两件事,起因是用户一句「把这个展开符号搞大一点,
                不然鼠标点着太费劲了」:

                1. **字形 12px → 16px 的 SVG 雪佛龙**。
                   原来是 Unicode 的 `▾` / `▸`,12px 的三角本来就小,而且
                   这两个字符在大多数字体里**垂直居中偏移**(下缘比上缘空),
                   所以它看着比实际字号更小。改用 SVG 之后,尺寸与居中都由
                   自己控制,放大也不会糊,还能加旋转过渡。

                2. **点击区 20×20 → 24×24**(行高 32px,放得下)。
                   目标尺寸低于 24px 对鼠标就是不友好 —— 这是通用原则,
                   Apple HIG 与 WCAG 2.2 的目标尺寸下限都是 24px。

                悬停时给一层底色,是为了让"这里可点"这件事**看得见** ——
                只有字形变色的话,用户仍然不知道该往哪儿瞄准。
              */
              className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800"
              onClick={(event) => {
                event.stopPropagation();
                toggleExpanded(node.id);
              }}
            >
              <svg
                viewBox="0 0 16 16"
                aria-hidden
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`h-4 w-4 transition-transform duration-150 ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              >
                <path d="M6 3.5 10.5 8 6 12.5" />
              </svg>
            </span>
          ) : (
            // 没有子节点时占同宽的位,否则同一列的徽章会参差不齐
            <span className="h-6 w-6 flex-none" />
          )}

          <span
            className={`flex h-5 w-5 flex-none items-center justify-center rounded text-xs font-medium ${
              node.depth === 0
                ? 'bg-blue-50 text-blue-700'
                : node.kind === 'space'
                  ? 'bg-teal-50 text-teal-700'
                  : 'bg-slate-100 text-slate-500'
            }`}
          >
            {kindBadge(node)}
          </span>

          {renamingId === node.id ? (
            <input
              autoFocus
              defaultValue={node.title}
              className="min-w-0 flex-1 rounded border border-blue-400 px-1 py-0.5 text-sm outline-none"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleRename(node, event.currentTarget.value);
                if (event.key === 'Escape') setRenamingId(null);
              }}
              onBlur={(event) => handleRename(node, event.target.value)}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate py-1" title={node.title}>
              {node.title}
            </span>
          )}

          {node.commentCount > 0 && renamingId !== node.id && (
            <span
              // ⚠️ 颜色刻意是**中性灰**,不是琥珀色。
              // 琥珀色等于暗示"有待处理的事",而评论只是评论 ——
              // 这个角标数的是"有几条评论",不是"有几个待解决问题"。
              className="flex-none rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-slate-500"
              title={`${String(node.commentCount)} 条评论`}
            >
              {node.commentCount}
            </span>
          )}

          {node.status !== 'published' && (
            <span className="flex-none rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
              {node.status === 'draft' ? '草稿' : '归档'}
            </span>
          )}

          {renamingId !== node.id && (
            /*
              ⚠️ 这排按钮必须**绝对定位**,不能占布局宽度。

              原来它在流里(`flex-none`),于是 6 个按钮常驻吃掉 130~160px ——
              而 320px 的行里,扣掉缩进、箭头、徽章之后只剩 215px,标题因此在
              **没悬停的时候就已经被提前截断**("CRM 项…")。字号从 13px 提到 14px
              之后更明显。

              改成悬浮覆盖:标题永远拿到完整宽度,按钮只在悬停时盖在右端。
              底色用 `bg-white`,与行的 `hover:bg-white` 完全一致,所以看不出接缝。
            */
            /*
              ⚠️ `opacity-0` + `group-hover` 在触屏上是**不可达**的:没有 hover 这回事,
              而那排按钮在手机上永远不出现(用户不知道怎么新建/重命名)。
              `focus-within:opacity-100` 让键盘也能唤出它;触屏仍然靠 `title` 无解,
              所以真正的出路是把这些动作放在节点页上 —— 那里现在已经有「重命名」
              与「可见范围」等按钮,不依赖悬停。
            */
            <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-white pl-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {canCreateUnder(node) && (
                <>
                  <button
                    type="button"
                    aria-label={'在「' + node.title + '」下新建页面'}
                    title="在此新建页面"
                    className={ROW_ACTION_CLASS}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCreate(node.id, 'document');
                    }}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={'在「' + node.title + '」下新建子空间'}
                    title="在此新建子空间 / 组"
                    className={ROW_ACTION_CLASS}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCreate(node.id, 'space');
                    }}
                  >
                    ⊞
                  </button>
                </>
              )}
              {nodeManageable && (
                <button
                  type="button"
                  aria-label={'「' + node.title + '」的权限设置'}
                  title="权限设置"
                  className={ROW_ACTION_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenGrants(node.id, node.title);
                  }}
                >
                  ⚙
                </button>
              )}
              {nodeManageable && (
                <button
                  type="button"
                  aria-label={'「' + node.title + '」的成员'}
                  title="成员(组织归属):这个节点下都有谁"
                  className={ROW_ACTION_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenMembers(node.id, node.title);
                  }}
                >
                  ☰
                </button>
              )}
              {nodeEditable && (
                <button
                  type="button"
                  aria-label={'重命名「' + node.title + '」'}
                  title="重命名"
                  className={ROW_ACTION_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRenamingId(node.id);
                  }}
                >
                  ✎
                </button>
              )}
              {nodeEditable && (
                <button
                  type="button"
                  // ⚠️ 这里原本写的是「移入回收站」—— 回收站 v2.12 已整体移除,
                  // 而删除现在是**不可恢复**的。留着旧文案会让用户以为还能捞回来。
                  aria-label={'删除「' + node.title + '」'}
                  title="删除(不可恢复)"
                  className={ROW_ACTION_DANGER_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDelete(node);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          )}
        </div>

        {isExpanded && node.children.length > 0 && (
          <ul role="group">{node.children.map((child) => renderNode(child))}</ul>
        )}
      </li>
    );
  }

  const dragging = dragId !== null;

  return (
    /*
      宽度从 288px 加到 320px:字号提到 14px 之后,同样的标题会更早被截断,
      而组织树里的名字(「市场部工作方式」这类)本来就偏长。
      加宽比缩字更对 —— 被截掉的名字是**信息丢失**,字小了只是**读着费劲**。
    */
    /*
      ⚠️ 窄屏隐藏(v2.12)。左右两栏各 320px:1024px 的屏上正文只剩 ~384px
      (v2.10 的表格菜单注释里已经算过这个数),390px 视口更是直接横向溢出 51px。
      `hidden md:flex` 在 768px 以下整栏收起 —— 那种宽度本来也不在阶段一的
      支持范围内(§1.3 明确不做移动端适配),但"不支持"与"溢出"是两回事:
      后者会让每一页都多一条横向滚动条,而且正文被压成一条细缝。
    */
    /*
      data-print="hide":左树是**框架**不是内容,打印时必须隐藏 ——
      见 styles.css 的 @media print(v2.16 起打印不再靠标签名猜框架)。
    */
    <div
      data-print="hide"
      className="hidden h-full w-72 flex-none flex-col border-r border-slate-200 bg-slate-50 md:flex xl:w-80"
    >
      <div className="flex flex-none items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <span className={`text-slate-500 ${T_LABEL}`}>组织结构 · {countNodes(nodes)}</span>
        <button
          type="button"
          title="新建页面(不挂在任何部门下,只有管理员可以)"
          disabled={createNode.isPending}
          className="rounded-md px-2 py-1 text-sm text-slate-500 transition-colors hover:bg-white hover:text-slate-900 disabled:opacity-50"
          onClick={() => handleCreate(null, 'document')}
        >
          + 顶层
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {dragging && (
          /*
            ⚠️ 拖拽说明**只在拖拽时出现**,不再常驻在侧栏底部。

            原来它是一段固定的三行灰字,永久占着左下角 —— 那是最典型的
            "信息架构没做,用说明书补"的味道:一块常驻的小字说明既难看,
            又因为一直在那儿而没人会读。放到**拖拽进行中**之后,
            它正好出现在需要它的那一刻,而且旁边就是落点提示框。
          */
          <div className="mb-1 space-y-1">
            <div
              className={`rounded-md border border-dashed px-2 py-1.5 text-center text-xs transition-colors ${
                rootDropActive
                  ? 'border-blue-400 bg-blue-50 text-blue-700'
                  : 'border-slate-300 text-slate-500'
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setRootDropActive(true);
              }}
              onDragLeave={() => setRootDropActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setRootDropActive(false);
                if (dragId === null) return;
                const dragged = findNode(nodes, dragId);
                setDragId(null);
                if (dragged !== undefined) {
                  moveNode.mutate({
                    nodeId: dragged.id,
                    newParentId: null,
                    version: dragged.version,
                  });
                }
              }}
            >
              放到这里 → 移到顶层
            </div>
            <p className={`px-1 text-slate-500 ${T_META}`}>
              上 / 下四分之一排到前 / 后,中间成为子节点。
            </p>
          </div>
        )}

        {nodes.length === 0 ? (
          <p className={`px-3 py-8 text-center leading-relaxed text-slate-500 ${T_BODY}`}>
            组织架构还是空的。
            <br />
            管理员可以到「组织架构」里建部门,或用 Excel 一次性导入全员名单。
          </p>
        ) : (
          <ul role="tree">{nodes.map((node) => renderNode(node))}</ul>
        )}
      </div>

      {/*
        ⚠️ 这里原来有一段**常驻的三行灰色说明文字**(讲拖拽怎么分上/下四分之一、
        悬停能看到 ⚙ 与 ☰)。它已经挪走了:
          · 拖拽说明 → 只在拖拽时出现(见上方)
          · 悬停能看到什么 → 是按钮的 `title` 该回答的事,不是侧栏该常驻的字
        一个侧栏的底部塞满小字说明,是"信息架构没做、用说明书补"的典型味道。
      */}
      <div className="flex-none space-y-0.5 border-t border-slate-200 p-2">
        <button
          type="button"
          className={`block w-full rounded-md px-3 py-2 text-left text-slate-500 transition-colors hover:bg-white hover:text-slate-900 ${T_BODY}`}
          onClick={() => void navigate('/audit')}
        >
          审计日志 →
        </button>
        <ErrorNote
          error={moveNode.error ?? createNode.error ?? updateNode.error ?? deleteNode.error}
        />
      </div>
    </div>
  );
}
