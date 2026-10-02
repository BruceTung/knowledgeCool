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
import { T_META, T_NAV } from '../../lib/typography';
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
 * v2.8:点击区 24px、字形跟着内容档。Atlassian 的规范里
 * "配合图标时用 Medium 字重",所以这里也给 `font-medium` —— 字形小、
 * 又细的时候,图标会显得脏。
 *
 * ⚠️ v2.17:点击区 24 → **28px**(`h-7 w-7`),并换成深底上的配色。
 * 24px 只是**下限**,而行本身已经从 36px 放到 44px —— 按钮也跟着长一点,
 * 行内才不会显得"大行小按钮"。悬停底色从 `slate-200` 换成 `white/10`:
 * 浅灰的半透明块压在深底上会发灰发脏。
 */
const ROW_ACTION_CLASS = `flex h-7 w-7 flex-none items-center justify-center rounded-md text-sm font-medium text-slate-400 transition-colors hover:bg-white/15 hover:text-white`;
const ROW_ACTION_DANGER_CLASS = `flex h-7 w-7 flex-none items-center justify-center rounded-md text-sm font-medium text-slate-400 transition-colors hover:bg-red-500/20 hover:text-red-300`;

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
    return scopes.some(
      (scope) => scope.nodeId === nodeId || isInsideSubtree(nodes, scope.nodeId, nodeId),
    );
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

  /**
   * 提交改名。
   *
   * ⚠️⚠️ v4.9:**失败时不能收起输入框。**
   *
   * 原实现第一行就 `setRenamingId(null)` —— **无条件**关掉输入框。
   * 于是改名失败时(409 乐观锁冲突、403、网络断开)会发生两件坏事:
   *   ① 用户刚敲进去的新标题**直接没了** —— 输入框已经卸载,那个值
   *      只存在于 DOM 里,再也拿不回来;
   *   ② 他唯一的线索是侧栏底部那条错误提示,而树很长时**根本看不见**
   *      (提示在面板底部,输入框在树的某个深处)。
   *
   * 这与 `NodeDetailPage` / `UsersAdminPage` 早先修过的是**同一个坑**,
   * 那两处都改成了"只在 `onSuccess` 里清状态"。这里照同样的做法 ——
   * 三处行为一致,才不会让人以为"树上的改名比较危险"。
   * (成功路径由 `invalidate` 重取树,标题会自然更新。)
   */
  function handleRename(node: OrgTreeNode, value: string): void {
    const next = value.trim();
    // 没改、或改成了空 —— 直接收起,不必发请求
    if (next === '' || next === node.title) {
      setRenamingId(null);
      return;
    }
    updateNode.mutate(
      { nodeId: node.id, title: next, version: node.version },
      {
        onSuccess: () => {
          setRenamingId(null);
        },
        // 失败**不**清 `renamingId`:输入框留在原地,用户能直接改一改重试
      },
    );
  }

  function handleDelete(node: OrgTreeNode): void {
    const size = countNodes([node]);
    const label =
      size > 1 ? `「${node.title}」及其下 ${String(size - 1)} 个节点` : `「${node.title}」`;
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

    /*
      ⚠️ v2.17:行高 36 → **44px**,字号 14 → 16px(`T_NAV`),底色改成深色壳。

      只放大字号而不放开行高,汉字会挤在一起反而更难读 —— 两者必须一起动。
      44px 与"点击目标 ≥ 24px"那条下限不冲突(它只是下限),
      而"在一条 44px 的行里鼠标不容易点偏"正是用户要的"更直观"。
    */
    const rowClass = [
      `group relative flex h-11 items-center gap-2 rounded-lg pr-2 ${T_NAV} transition-colors`,
      // 选中行用 CSS 类(青色指示条 + 由内向外渐隐的底色),不用纯色块 ——
      // 纯 `bg-white` 在深底上是一块刺眼的白砖,把整列的层次全压平了。
      isActive ? 'kc-tree-active' : 'text-slate-300 hover:bg-white/10',
      forbidden && dragId !== null ? 'opacity-40' : '',
      target === 'into' ? 'ring-2 ring-sky-400' : '',
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
        /*
          漫游 tabindex:整棵树只有**一个**可 Tab 进入的点。

          ⚠️⚠️ v4.9:**必须有一个兜底**,否则整棵树键盘进不去。

          原来的判据是 `focusedId === node.id || (focusedId === null && isActive)` ——
          只看"聚焦过"或"是当前打开的节点"。而**在 `/`、`/search`、`/audit`
          这些页面上根本没有 active 节点**,同时用户还没在树里聚焦过任何一行,
          于是 `focusedId === null && isActive` 对**每一行**都是 false ——
          **整棵树一个 tab stop 都没有,键盘永远进不去**。

          补上第三项:都没聚焦过、也没有 active 节点时,落在**第一行**上。
          这样"漫游 tabindex"那条规则在任何页面上都成立(始终恰好一个 tab stop)。
        */
        tabIndex={
          focusedId !== null
            ? focusedId === node.id
              ? 0
              : -1
            : isActive || node.id === visibleIds[0]
              ? 0
              : -1
        }
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
            // ⚠️ 缩进步长与"箭头中心"是**一组数**,改一个必须改另一个(v2.17)。
            //
            // 步长 13 → 16px,因为箭头从 24px 放大到了 28px(`h-7 w-7`)。
            // 算式:缩进 = depth*16 + 4;箭头中心 = 缩进 + 14(箭头宽的一半)
            //                     = depth*16 + 18。
            // 下面的引导线落在 `18 + level*16` —— 正好是**上一级箭头的中点**,
            // 所以竖线看起来是从父节点的展开箭头正中延伸下来的。
            // 两者若不同步,表现是整列竖线系统性偏几像素,而且没人知道该改哪边。
            paddingLeft: `${String(Math.min(node.depth, 8) * 16 + 4)}px`,
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

            位置:第 i 级祖先的引导线落在 `18 + i*16`(与上面的缩进算式配套,见那里的说明)。
            用 `inset-y-0` 让它在相邻行之间连成一条,而不是一段一段的。
            颜色走 `.kc-tree-guide` 类而不是写死 `bg-slate-200`:深底上浅灰竖线
            会**比内容还显眼**,需要单独压淡(见 styles.css)。
          */}
          {Array.from({ length: Math.min(node.depth, 8) }, (_, level) => (
            <span
              key={`guide-${String(level)}`}
              aria-hidden
              className="kc-tree-guide pointer-events-none absolute inset-y-0 w-px"
              style={{ left: `${String(18 + level * 16)}px` }}
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
                   ⚠️ v2.17 再放到 **28×28**(行高 44px):用户这次说"还是太小",
                   那就不要卡着下限给 —— 下限是"别低于",不是"就按这个来"。

                悬停时给一层底色,是为了让"这里可点"这件事**看得见** ——
                只有字形变色的话,用户仍然不知道该往哪儿瞄准。
              */
              className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/15 hover:text-white"
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
                /* 16 → 20px:与行内 16px 的文字同高,视觉上才配得上 */
                className={`h-5 w-5 transition-transform duration-150 ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              >
                <path d="M6 3.5 10.5 8 6 12.5" />
              </svg>
            </span>
          ) : (
            // 没有子节点时占同宽的位,否则同一列的徽章会参差不齐
            // ⚠️ 必须与上面那个箭头的尺寸**同步**(v2.17 起是 28px),
            // 否则叶子节点的徽章会比有子节点的往左错 4px,整列看起来是歪的。
            <span className="h-7 w-7 flex-none" />
          )}

          {/*
            类型徽章(部 / 组 / 页)。v2.17:20×20 → **24×24**,字号 12 → 14px。
            深底上的配色改成"半透明底 + 浅色字 + 细描边"——
            原来那种 `bg-blue-50`(接近纯白)在深色树里是一块刺眼的小白点。
          */}
          <span
            className={`flex h-6 w-6 flex-none items-center justify-center rounded-md text-sm font-medium ${
              node.depth === 0
                ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30'
                : node.kind === 'space'
                  ? 'bg-teal-500/20 text-teal-200 ring-1 ring-teal-400/30'
                  : 'bg-white/10 text-slate-300'
            }`}
          >
            {kindBadge(node)}
          </span>

          {renamingId === node.id ? (
            /*
              ⚠️⚠️ v4.9:这个输入框里的按键**必须阻止冒泡**。

              它是 `role="treeitem"` 那一行**里面**的一个元素,而那一行的
              `onKeyDown` 处理 Enter / 方向键 / Home / End。不拦住的话:
                · **Enter** 会先提交改名,再冒泡上去被当成"打开这个节点" ——
                  一次按键干了两件事,而且第二件把用户带离了当前位置;
                · **方向键 / Home / End** 会被那一行 `preventDefault()` 掉,
                  于是**改名时挪不动光标**(想改中间几个字都做不到)。

              所以这里一律 `stopPropagation()`:输入框是"编辑中"的上下文,
              行级快捷键在这一刻没有意义。
            */
            <input
              autoFocus
              defaultValue={node.title}
              /* ⚠️ v4.33：树里重命名的输入框，补无障碍名（带上原标题便于分辨）。 */
              aria-label={`重命名「${node.title}」`}
              className="min-w-0 flex-1 rounded-md border border-sky-400/60 bg-white/10 px-2 py-1 text-base text-white outline-none"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                // 所有按键都留在输入框里,不要给行级的树导航处理
                event.stopPropagation();
                if (event.key === 'Enter') handleRename(node, event.currentTarget.value);
                if (event.key === 'Escape') setRenamingId(null);
              }}
              onBlur={(event) => {
                handleRename(node, event.target.value);
              }}
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
              className="flex-none rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-300"
              title={`${String(node.commentCount)} 条评论`}
            >
              {node.commentCount}
            </span>
          )}

          {node.status !== 'published' && (
            <span className="flex-none rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-200 ring-1 ring-amber-400/30">
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
            /*
              ⚠️⚠️ v4.36:这 6 个操作按钮全部 `tabIndex={-1}`,**不占 tab 停靠点**。

              背景:上面那段注释已经说明树用「漫游 tabindex」——整棵树**只该有 1 个**
              可 Tab 进入的点。但这一排按钮在 `role="treeitem"` **里面**,各自都是独立的
              tab 停靠点,于是实测变成:

                treeitems=7, focusableTotal=31, perRow=[30,6,6,6,6,0,0]

              也就是**每行 6 个**、整棵树 31 个。要用 Tab 穿过一棵 20 行的树得按 120 多次,
              而 §7.7 声称的是「单一 roving tab stop」—— 声明与实际不符。

              `tabIndex={-1}` 之后它们:鼠标**照样**能点(`onClick` 不受影响)、
              `group-hover` / `focus-within` 照样唤出,只是不再抢 Tab 键。

              ⚠️ **那键盘用户怎么够到这些动作?** 这是这次改动必须回答的问题 ——
              答案是**不靠这排悬浮按钮**,而靠已经存在的两条路径:
                · 选中一行(树内 ↑/↓)→ 按 Enter 打开节点页,节点页上已经有
                  「重命名」「可见范围」等按钮,不依赖悬停;
                · 新建 / 删除等操作在节点页与超管界面里都有入口。
              这也正是原注释里那句「真正的出路是把这些动作放在节点页上」的落实。
              (触屏本来就没有 hover,原本也只能走节点页 —— 现在两者一致了。)
            */
            <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-white pl-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {canCreateUnder(node) && (
                <>
                  <button
                    type="button"
                    aria-label={'在「' + node.title + '」下新建页面'}
                    title="在此新建页面"
                    tabIndex={-1}
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
                    tabIndex={-1}
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
                  tabIndex={-1}
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
                  tabIndex={-1}
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
                  tabIndex={-1}
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
                  tabIndex={-1}
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
      /*
        ⚠️ 宽度**刻意保持 320px**,不吃更多横向空间(v2.17)。

        本来想跟着字号一起加宽到 384px,试过之后**退回了**:实测 1440px 的窗口下
        正文列会从 806px 掉到 720px,而编辑器工具栏的固有宽度在 720 里放不下 ——
        它会折成两行。用户在 v2.8 已经因为"按钮文字过长折行"提过一次,
        所以这里宁可让个别长标题多截一点,也不把工具栏挤折。

        字号大了之后确实更容易截断,这一点用 **44px 行高 + 16px 字号**带来的
        可读性提升来补,而不是靠抢正文的宽度。真要加宽,得先解决工具栏折行。
      */
      className="kc-chrome hidden h-full w-80 flex-none flex-col border-r border-sky-500/15 md:flex"
    >
      <div className="flex flex-none items-center justify-between gap-2 border-b border-sky-500/15 px-4 py-3">
        <span className="text-sm font-medium text-slate-300">
          组织结构 · <span className="tabular-nums">{countNodes(nodes)}</span>
        </span>
        <button
          type="button"
          title="新建页面(不挂在任何部门下,只有管理员可以)"
          disabled={createNode.isPending}
          className="rounded-md border border-sky-400/20 px-2.5 py-1 text-sm font-medium text-slate-300 transition-colors hover:border-sky-400/40 hover:bg-white/10 hover:text-white disabled:opacity-50"
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
                  ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                  : 'border-slate-500/60 text-slate-400'
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
            <p className={`kc-chrome-muted px-1 ${T_META}`}>
              上 / 下四分之一排到前 / 后,中间成为子节点。
            </p>
          </div>
        )}

        {nodes.length === 0 ? (
          <p className={`px-3 py-8 text-center leading-relaxed text-slate-400 ${T_NAV}`}>
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
      <div className="flex-none space-y-0.5 border-t border-sky-500/15 p-2">
        <button
          type="button"
          className={`block w-full rounded-md px-3 py-2.5 text-left text-slate-300 transition-colors hover:bg-white/10 hover:text-white ${T_NAV}`}
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
