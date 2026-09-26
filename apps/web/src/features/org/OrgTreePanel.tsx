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
}

/** 节点类型的中文短标。 */
function kindBadge(node: OrgTreeNode): string {
  if (node.depth === 0) return '部';
  if (node.kind === 'space') return '组';
  return '页';
}

export function OrgTreePanel({
  tree,
  scopes,
  isSuperAdmin,
  activeNodeId,
  onOpenGrants,
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
      'group relative flex items-center gap-1 rounded-md pr-1 text-sm transition-colors',
      isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:bg-white/70',
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
          style={{ paddingLeft: `${String((node.depth > 2 ? 2 : node.depth) * 12 + 4)}px` }}
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
              className="flex h-4 w-4 flex-none items-center justify-center text-[9px] text-slate-400 hover:text-slate-700"
              onClick={(event) => {
                event.stopPropagation();
                toggleExpanded(node.id);
              }}
              aria-label={isExpanded ? '折叠' : '展开'}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="h-4 w-4 flex-none" />
          )}

          <span
            className={`flex h-4 w-4 flex-none items-center justify-center rounded text-[9px] ${
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

          {node.openCommentCount > 0 && renamingId !== node.id && (
            <span
              className="flex-none rounded-full bg-amber-50 px-1.5 text-[10px] text-amber-700 ring-1 ring-amber-200"
              title={`${String(node.openCommentCount)} 条未解决评论`}
            >
              {node.openCommentCount}
            </span>
          )}

          {node.status !== 'published' && (
            <span className="flex-none rounded bg-slate-100 px-1 text-[10px] text-slate-500">
              {node.status === 'draft' ? '草稿' : '归档'}
            </span>
          )}

          {renamingId !== node.id && (
            <span className="flex flex-none items-center opacity-0 transition-opacity group-hover:opacity-100">
              {canCreateUnder(node) && (
                <>
                  <button
                    type="button"
                    title="在此新建页面"
                    className="h-5 w-5 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
                    className="h-5 w-5 rounded text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
                  className="h-5 w-5 rounded text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenGrants(node.id, node.title);
                  }}
                >
                  ⚙
                </button>
              )}
              {nodeEditable && (
                <button
                  type="button"
                  title="重命名"
                  className="h-5 w-5 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
                  className="h-5 w-5 rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
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
    <div className="flex h-full w-72 flex-none flex-col border-r border-slate-200 bg-slate-50">
      <div className="flex flex-none items-center gap-2 px-3 py-2">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-slate-400">
          组织结构 · {countNodes(nodes)}
        </span>
        <button
          type="button"
          title="新建页面(不挂在任何部门下,只有管理员可以)"
          disabled={createNode.isPending}
          className="rounded px-1.5 text-xs text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-50"
          onClick={() => handleCreate(null, 'document')}
        >
          + 顶层
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {dragging && (
          <div
            className={`mb-1 rounded-md border border-dashed px-2 py-1 text-center text-[11px] transition-colors ${
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
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-slate-400">
            组织架构还是空的。
            <br />
            管理员可以到「组织架构」里建部门,或用 Excel 一次性导入全员名单。
          </p>
        ) : (
          <ul role="tree">{nodes.map((node) => renderNode(node))}</ul>
        )}
      </div>

      <div className="flex-none space-y-1 border-t border-slate-200 p-2">
        <button
          type="button"
          className="block w-full rounded-md px-2 py-1 text-left text-xs text-slate-500 hover:bg-white hover:text-slate-800"
          onClick={() => void navigate('/trash')}
        >
          回收站 →
        </button>
        <button
          type="button"
          className="block w-full rounded-md px-2 py-1 text-left text-xs text-slate-500 hover:bg-white hover:text-slate-800"
          onClick={() => void navigate('/audit')}
        >
          审计日志 →
        </button>
        <ErrorNote
          error={moveNode.error ?? createNode.error ?? updateNode.error ?? deleteNode.error}
        />
        <p className="px-2 text-[10px] leading-relaxed text-slate-400">
          可直接拖拽调整层级与顺序:上/下四分之一是"排到前/后",中间是"成为子节点"。
        </p>
      </div>
    </div>
  );
}
