import { can, type PageNode, type SpaceRole } from '@knowledgecool/shared';
import { useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ErrorNote } from '../../components/ui';
import { useCreatePage, useDeletePage, useMovePage, useUpdatePage } from './queries';
import {
  countPages,
  defaultExpandedIds,
  expandedIdsFor,
  findNode,
  isInsideSubtree,
  locateNode,
} from './tree-utils';

/** 拖拽落点的三种语义。与原型一致:上四分之一=前,下四分之一=后,中间=成为子节点。 */
type DropZone = 'before' | 'into' | 'after';

interface PageTreePanelProps {
  spaceId: string;
  nodes: readonly PageNode[];
  role: SpaceRole;
  /** 当前打开的页面 —— 高亮它,并自动展开到它的路径。 */
  activePageId: string | undefined;
  /**
   * 各页面的未解决评论数(§8.4:阶段一不发通知,靠这个角标让人知道有讨论)。
   * 缺省为空对象 —— 评论数拿不到不该影响树的渲染。
   */
  commentCounts?: Record<string, number>;
}

/**
 * 页面树面板(DESIGN.md §7.2 的左侧栏)。
 *
 * 折叠状态、拖拽状态都是**本地 UI 状态**,不进全局 store ——
 * 它们只在这个面板内有意义(Zustand 留给 M4 之后真正跨组件的选中态)。
 *
 * 权限在这里只用来**决定显示什么**。服务端仍是唯一裁判:
 * 即使有人把按钮抠出来点,后端照样 403。
 */
export function PageTreePanel({
  spaceId,
  nodes,
  role,
  activePageId,
  commentCounts,
}: PageTreePanelProps) {
  const navigate = useNavigate();
  const createPage = useCreatePage(spaceId);
  const updatePage = useUpdatePage(spaceId);
  const movePage = useMovePage(spaceId);
  const deletePage = useDeletePage(spaceId);

  // 与后端共用同一份能力矩阵,不手写 role === 'editor' || role === 'admin'
  const canCreate = can(role, 'page.create');
  const canEdit = can(role, 'page.edit');
  const canDelete = can(role, 'page.delete');

  /**
   * 展开状态用「派生 + 覆盖」,而不是把最终结果存进 state。
   *
   * 自动展开的部分(前两层 + 当前页所在路径)完全由 nodes 算出来,state 只存
   * 用户**手动改过**的节点。两个好处:
   *  1. 不需要 effect —— 在 effect 里同步 setState 会触发级联渲染
   *     (eslint 的 react-hooks 规则会直接拦下来);
   *  2. 树刷新后不会出现莫名的开合跳变:自动部分随时跟着数据走,
   *     手动部分不会被覆盖掉。
   */
  const autoExpanded = useMemo(() => {
    const ids = new Set(defaultExpandedIds(nodes));
    if (activePageId !== undefined) {
      for (const id of expandedIdsFor(nodes, activePageId)) ids.add(id);
    }
    return ids;
  }, [nodes, activePageId]);

  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: DropZone } | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);

  /** 手动设置优先于自动展开。 */
  const isNodeExpanded = (id: string): boolean => overrides.get(id) ?? autoExpanded.has(id);

  const setExpandedState = (id: string, open: boolean): void => {
    setOverrides((prev) => new Map(prev).set(id, open));
  };

  const toggleExpanded = (id: string): void => {
    setExpandedState(id, !isNodeExpanded(id));
  };

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

  function performMove(targetId: string, zone: DropZone) {
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

    movePage.mutate({
      pageId: dragged.id,
      newParentId,
      version: dragged.version,
      ...(newPosition === undefined ? {} : { newPosition }),
    });
  }

  function handleCreate(parentId: string | null) {
    createPage.mutate(
      { parentId },
      {
        onSuccess: (created) => {
          // 新建后要保证父节点是展开的,否则新页面看不见
          if (parentId !== null) setExpandedState(parentId, true);
          setRenamingId(created.id);
          void navigate(`/s/${spaceId}/p/${created.id}`);
        },
      },
    );
  }

  function handleRename(node: PageNode, value: string) {
    setRenamingId(null);
    const next = value.trim();
    if (next === '' || next === node.title) return;
    updatePage.mutate({ pageId: node.id, title: next, version: node.version });
  }

  function handleDelete(node: PageNode) {
    const label = node.children.length > 0 ? `「${node.title}」及其所有子页面` : `「${node.title}」`;
    if (!window.confirm(`将 ${label} 移入回收站?`)) return;
    deletePage.mutate(node.id);
  }

  function renderNode(node: PageNode) {
    const isExpanded = isNodeExpanded(node.id);
    const isActive = node.id === activePageId;
    const forbidden = dragId !== null && isForbiddenTarget(node.id);
    const target = dropTarget?.id === node.id ? dropTarget.zone : null;

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
          draggable={canEdit && renamingId !== node.id}
          className={rowClass}
          style={{ paddingLeft: `${String(node.depth * 12 + 4)}px` }}
          onClick={() => void navigate(`/s/${spaceId}/p/${node.id}`)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void navigate(`/s/${spaceId}/p/${node.id}`);
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
          {/* 落位指示线:before / after */}
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

          {(commentCounts?.[node.id] ?? 0) > 0 && renamingId !== node.id && (
            <span
              className="flex-none rounded-full bg-amber-50 px-1.5 text-[10px] text-amber-700 ring-1 ring-amber-200"
              title={`${String(commentCounts?.[node.id] ?? 0)} 条未解决评论`}
            >
              {commentCounts?.[node.id] ?? 0}
            </span>
          )}

          {node.status !== 'published' && (
            <span className="flex-none rounded bg-slate-100 px-1 text-[10px] text-slate-500">
              {node.status === 'draft' ? '草稿' : '归档'}
            </span>
          )}

          {(canCreate || canEdit || canDelete) && renamingId !== node.id && (
            <span className="flex flex-none items-center opacity-0 transition-opacity group-hover:opacity-100">
              {canCreate && (
                <button
                  type="button"
                  title="新建子页面"
                  className="h-5 w-5 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCreate(node.id);
                  }}
                >
                  +
                </button>
              )}
              {canEdit && (
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
              {canDelete && (
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
          页面 · {countPages(nodes)}
        </span>
        {canCreate && (
          <button
            type="button"
            title="新建顶层页面"
            disabled={createPage.isPending}
            className="rounded px-1.5 text-xs text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-50"
            onClick={() => handleCreate(null)}
          >
            + 新建
          </button>
        )}
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
                movePage.mutate({
                  pageId: dragged.id,
                  newParentId: null,
                  version: dragged.version,
                });
              }
            }}
          >
            放到这里 → 移为顶层页面
          </div>
        )}

        {nodes.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-slate-400">
            还没有页面。
            {canCreate ? '点右上角「新建」开始。' : '请联系空间管理员创建。'}
          </p>
        ) : (
          <ul role="tree">{nodes.map((node) => renderNode(node))}</ul>
        )}
      </div>

      <div className="flex-none space-y-1 border-t border-slate-200 p-2">
        <Link
          to={`/s/${spaceId}/trash`}
          className="block rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-white hover:text-slate-800"
        >
          回收站 →
        </Link>
        <ErrorNote error={movePage.error ?? createPage.error ?? updatePage.error ?? deletePage.error} />
        {canEdit && (
          <p className="px-2 text-[10px] leading-relaxed text-slate-400">
            可直接拖拽调整层级与顺序。
          </p>
        )}
      </div>
    </div>
  );
}
