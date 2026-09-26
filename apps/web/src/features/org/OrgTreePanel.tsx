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
import { useMemo, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorNote } from '../../components/ui';
import { T_BADGE, T_BODY } from '../../lib/typography';
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
 * ⚠️ 这几个按钮原来是**各写各的** —— 有的带 `text-[11px]`,有的不写
 * (于是继承父级的字号),于是一行里 6 个按钮出现两种字号。
 * 这就是「图标、字体大小、字样都不对称」最直接的来源(用户 2026-09-27 反馈)。
 *
 * 收敛成常量之后,新增按钮不会再各写一份规格。
 *
 * v2.6 起尺寸跟着刻度走:字形 12px(`text-xs`)、点击区 24px(`h-6 w-6`)——
 * 原来字形 13px 挤在 20px 的方框里,鼠标也不好点。
 */
const ROW_ACTION_CLASS = `flex h-6 w-6 flex-none items-center justify-center rounded text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700`;
const ROW_ACTION_DANGER_CLASS = `flex h-6 w-6 flex-none items-center justify-center rounded text-xs text-slate-400 hover:bg-red-50 hover:text-red-600`;

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

  function handleCreate(parentId: string | null, kind: 'space' | 'document'): void {
    createNode.mutate(
      { parentId, kind },
      {
        onSuccess: (created) => {
          // 新建后保证父节点是展开的,否则新节点看不见
          if (parentId !== null) setExpandedState(parentId, true);
          setRenamingId(created.id);
          void navigate(`/n/${created.id}`);
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
    if (!window.confirm(`将 ${label} 移入回收站?`)) return;
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
      // `h-8`(32px)配内容级字号。原来是 `h-7` 配 13px —— 用户两次反馈左栏
      // "字体太小",根子就是这里:树行是**要被读的内容**(`T_BODY`),
      // 却比正文(15px)小了两级、和标签一个尺寸。
      `group relative flex h-8 items-center gap-1 rounded-md pr-1 ${T_BODY} transition-colors`,
      isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:bg-white',
      forbidden && dragId !== null ? 'opacity-40' : '',
      target === 'into' ? 'ring-2 ring-blue-400' : '',
    ].join(' ');

    return (
      <li key={node.id}>
        <div
          role="treeitem"
          aria-selected={isActive}
          tabIndex={0}
          draggable={nodeEditable && renamingId !== node.id}
          className={rowClass}
          style={{
            // ⚠️ 缩进必须**跟着 depth 走**。
            //
            // 原来这里写的是 `(node.depth > 2 ? 2 : node.depth) * 12 + 4` ——
            // depth 超过 2 就被钳成 2,于是「第三级组下面的页面」与它的父节点
            // 缩进完全相同,一列看下去看不出谁属于谁(用户 2026-09-27 反馈)。
            // 现在只在一个很深的层级封顶,纯粹是为了防止整行被推到看不见。
            paddingLeft: `${String(Math.min(node.depth, 8) * 13 + 6)}px`,
          }}
          onClick={() => void navigate(`/n/${node.id}`)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void navigate(`/n/${node.id}`);
          }}
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

          {node.children.length > 0 ? (
            <button
              type="button"
              // ⚠️ 展开箭头原来只有 9px —— 那么小的 ▾/▸ 几乎看不出是箭头。
              // (这里刻意不写出那个类名:字号扫描器不区分注释,见 `lib/typography.ts`。)
              // 它是**要能被认出**的控件,不是装饰,所以跟着徽章一档走。
              className="flex h-5 w-5 flex-none items-center justify-center text-xs text-slate-400 hover:text-slate-700"
              onClick={(event) => {
                event.stopPropagation();
                toggleExpanded(node.id);
              }}
              aria-label={isExpanded ? '折叠' : '展开'}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="h-5 w-5 flex-none" />
          )}

          <span
            className={`flex h-5 w-5 flex-none items-center justify-center rounded ${T_BADGE} font-medium ${
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
              className={`flex-none rounded-full bg-slate-100 px-1.5 ${T_BADGE} tabular-nums text-slate-500`}
              title={`${String(node.commentCount)} 条评论`}
            >
              {node.commentCount}
            </span>
          )}

          {node.status !== 'published' && (
            <span className={`flex-none rounded bg-slate-100 px-1 ${T_BADGE} text-slate-500`}>
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
            <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-white pl-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {canCreateUnder(node) && (
                <>
                  <button
                    type="button"
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
                  title="移入回收站"
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
    <div className="flex h-full w-80 flex-none flex-col border-r border-slate-200 bg-slate-50">
      <div className="flex flex-none items-center gap-2 border-b border-slate-200 px-3 py-2.5">
        <span className={`flex-1 font-medium text-slate-500 text-xs`}>
          组织结构 · {countNodes(nodes)}
        </span>
        <button
          type="button"
          title="新建页面(不挂在任何部门下,只有管理员可以)"
          disabled={createNode.isPending}
          className={`rounded px-1.5 py-0.5 text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-50 text-xs`}
          onClick={() => handleCreate(null, 'document')}
        >
          + 顶层
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {dragging && (
          <div
            className={`mb-1 rounded-md border border-dashed px-2 py-1 text-center transition-colors text-xs ${
              rootDropActive
                ? 'border-blue-400 bg-blue-50 text-blue-700'
                : 'border-slate-300 text-slate-400'
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
                moveNode.mutate({ nodeId: dragged.id, newParentId: null, version: dragged.version });
              }
            }}
          >
            放到这里 → 移到顶层
          </div>
        )}

        {nodes.length === 0 ? (
          <p className={`px-2 py-6 text-center leading-relaxed text-slate-400 text-xs`}>
            组织架构还是空的。
            <br />
            管理员可以到「组织架构」里建部门,或用 Excel 一次性导入全员名单。
          </p>
        ) : (
          <ul role="tree">{nodes.map((node) => renderNode(node))}</ul>
        )}
      </div>

      <div className="flex-none space-y-0.5 border-t border-slate-200 p-2">
        <button
          type="button"
          className={`block w-full rounded-md px-2 py-1.5 text-left text-slate-500 hover:bg-white hover:text-slate-800 text-xs`}
          onClick={() => void navigate('/trash')}
        >
          回收站 →
        </button>
        <button
          type="button"
          className={`block w-full rounded-md px-2 py-1.5 text-left text-slate-500 hover:bg-white hover:text-slate-800 text-xs`}
          onClick={() => void navigate('/audit')}
        >
          审计日志 →
        </button>
        <ErrorNote
          error={moveNode.error ?? createNode.error ?? updateNode.error ?? deleteNode.error}
        />
        <p className={`px-2 pt-1 leading-relaxed text-slate-400 text-xs`}>
          可直接拖拽调整层级与顺序:上/下四分之一是"排到前/后",中间是"成为子节点"。
          悬停节点行可见 ⚙(权限 · 谁能改)与 ☰(成员 · 归属在哪)。
        </p>
      </div>
    </div>
  );
}
