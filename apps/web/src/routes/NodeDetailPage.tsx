import type { Editor } from '@tiptap/core';
import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, ErrorNote } from '../components/ui';
import { useMe } from '../features/auth/queries';
import { CommentsPanel } from '../features/comments/CommentsPanel';
import { useComments } from '../features/comments/queries';
import {
  PageEditor,
  SaveStateLabel,
  type OutlineItem,
  type SaveState,
} from '../features/content/PageEditor';
import { useGrantDialog } from '../features/grants/dialog-store';
import { useMembersDialog } from '../features/members/dialog-store';
import { useExportMarkdown, useNodeContent, useNodeDetail, useUpdateNode } from '../features/org/queries';

type RightTab = 'outline' | 'comments';

/**
 * 文档页 —— 唯一的主工作面(DESIGN.md §7.2)。
 *
 * 布局:面包屑 + 标题 + 正文(左) / 目录·评论(右)。
 * 高频动作是「找到一篇 → 读 → 改」,所以任何额外的导航层级都是成本。
 *
 * ⚠️ v2.0 的三处变化:
 *   1. 路由从 `/s/:spaceId/p/:pageId` 变成 **`/n/:nodeId`** ——
 *      空间与页面已合并成一棵树,路径里不再需要空间这一层。
 *   2. `canEdit` / `canManage` **由服务端给**(`NodeDetail` 上带着),
 *      前端不再自己按角色算。角色这个概念已经不存在了。
 *   3. 所有者与创建者可能**已离职** —— 用户明确要求在这种页面上标出来。
 */
export function NodeDetailPage() {
  const { nodeId } = useParams<{ nodeId: string }>();

  if (nodeId === undefined) {
    return <p className="p-8 text-sm text-slate-500">缺少节点标识。</p>;
  }
  return <NodeDetailView nodeId={nodeId} />;
}

/** 离职标记。历史记录不抹掉,只在名字旁注明(v2.2)。 */
function DepartedBadge() {
  return (
    <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-700 ring-1 ring-amber-200">
      已离职
    </span>
  );
}

function NodeDetailView({ nodeId }: { nodeId: string }) {
  const detail = useNodeDetail(nodeId);
  const content = useNodeContent(nodeId);
  const updateNode = useUpdateNode();
  const comments = useComments(nodeId);
  const exportMd = useExportMarkdown();
  const openGrants = useGrantDialog((state) => state.open);
  const openMembers = useMembersDialog((state) => state.open);
  const me = useMe();

  // 切换节点要重建编辑器(见 PageEditor 顶部关于「content 只在挂载时读一次」的说明)。
  // 用 `key` 控制重建,而不是靠 props 更新 —— 后者会把正在输入的内容重置掉。
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [tab, setTab] = useState<RightTab>('outline');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [editorRef, setEditorRef] = useState<Editor | null>(null);

  // 这三个回调要稳定,否则 PageEditor 里的 effect 每次渲染都会重跑
  const handleOutline = useCallback((items: OutlineItem[]) => {
    setOutline(items);
  }, []);
  const handleSaveState = useCallback((state: SaveState) => {
    setSaveState(state);
  }, []);
  const handleReady = useCallback((instance: Editor) => {
    setEditorRef(instance);
  }, []);

  // ⚠️ 取的是**评论总数**,不是"待解决数" —— 这个系统里没有"问题"这个概念。
  const commentCount = comments.data?.total ?? 0;
  const tabs = useMemo(
    () =>
      [
        {
          key: 'outline' as const,
          label: `目录${outline.length > 0 ? ` (${String(outline.length)})` : ''}`,
        },
        {
          key: 'comments' as const,
          label: `评论${commentCount > 0 ? ` (${String(commentCount)})` : ''}`,
        },
      ] satisfies { key: RightTab; label: string }[],
    [outline.length, commentCount],
  );

  if (detail.isPending || content.isPending) {
    return <p className="p-8 text-sm text-slate-400">加载中…</p>;
  }
  if (detail.isError) {
    return (
      <div className="p-8">
        <ErrorNote error={detail.error} />
      </div>
    );
  }
  if (content.isError) {
    return (
      <div className="p-8">
        <ErrorNote error={content.error} />
      </div>
    );
  }

  const node = detail.data;
  const canEdit = node.canEdit;

  function commitTitle(value: string) {
    setTitleDraft(null);
    const next = value.trim();
    if (next === '' || next === node.title) return;
    updateNode.mutate({ nodeId: node.id, title: next, version: node.version });
  }

  function scrollToHeading(index: number) {
    // 大纲序号与正文里 h1/h2/h3 的顺序一一对应(extractOutline 只收 1~3 级)
    const headings = editorRef?.view.dom.querySelectorAll('h1, h2, h3');
    headings?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex-none border-b border-slate-200 px-6 pt-4 pb-3">
          <nav className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
            <Link to="/" className="hover:text-slate-600">
              全部
            </Link>
            {node.breadcrumb.slice(0, -1).map((crumb) => (
              <span key={crumb.id} className="flex items-center gap-1">
                <span>/</span>
                <Link to={`/n/${crumb.id}`} className="hover:text-slate-600">
                  {crumb.title}
                </Link>
              </span>
            ))}
          </nav>

          <div className="mt-1 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {titleDraft !== null ? (
                <input
                  autoFocus
                  defaultValue={node.title}
                  className="w-full rounded-md border border-blue-400 px-2 py-1 text-2xl font-semibold outline-none"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitTitle(event.currentTarget.value);
                    if (event.key === 'Escape') setTitleDraft(null);
                  }}
                  onBlur={(event) => commitTitle(event.target.value)}
                />
              ) : (
                <h1
                  // `text-xl`(20px)而不是 `text-2xl`(24px):下面那行元信息是 12px,
                  // 24px 配 12px 落差太大,标题像是"贴"在页面上而不是长在页面里。
                  className={`text-xl font-semibold text-slate-900 ${
                    canEdit ? 'cursor-text rounded-md px-2 py-1 hover:bg-slate-50' : 'px-2 py-1'
                  }`}
                  title={canEdit ? '点击可改名' : undefined}
                  onClick={() => {
                    if (canEdit) setTitleDraft(node.title);
                  }}
                >
                  {node.title}
                </h1>
              )}

              <div className="flex flex-wrap items-center gap-3 px-2 text-xs text-slate-400">
                <SaveStateLabel state={saveState} />
                <span>所有者 {node.ownerName}</span>
                {node.ownerDeparted && <DepartedBadge />}
                <span>
                  创建者 {node.createdByName}
                  {node.createdByDeparted && <DepartedBadge />}
                </span>
                <span>更新于 {new Date(node.updatedAt).toLocaleString('zh-CN')}</span>
              </div>
            </div>

            <div className="flex flex-none items-center gap-2 pt-1">
              {/*
                「成员」只出现在空间 / 组这类节点上。文档页面上也有"归属"这个概念,
                但在那里加人没有实际意义(没人会"归属于某篇文档"),
                多一个入口只会让界面变吵。
                超管对一级部门不是内容所有者(canManage 为假),但组织架构归他管 —— 单独放行。
              */}
              {node.kind === 'space' && (node.canManage || me.data?.user.isSuperAdmin === true) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    openMembers(node.id, node.title);
                  }}
                >
                  成员
                </Button>
              )}
              {node.canManage && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    openGrants(node.id, node.title);
                  }}
                >
                  权限
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={exportMd.isPending}
                title="导出为 Markdown 文件"
                onClick={() => {
                  exportMd.mutate({ nodeId: node.id, title: node.title });
                }}
              >
                {exportMd.isPending ? '导出中…' : '导出 MD'}
              </Button>
            </div>
          </div>

          {updateNode.isError && (
            <div className="mt-2 px-2">
              <ErrorNote error={updateNode.error} />
            </div>
          )}
          {exportMd.isError && (
            <div className="mt-2 px-2">
              <ErrorNote error={exportMd.error} />
            </div>
          )}
        </header>

        <PageEditor
          key={nodeId}
          nodeId={nodeId}
          initial={content.data}
          canEdit={canEdit}
          onOutline={handleOutline}
          onSaveStateChange={handleSaveState}
          onReady={handleReady}
        />
      </div>

      <aside className="flex w-80 flex-none flex-col border-l border-slate-200 bg-slate-50">
        <div className="flex flex-none border-b border-slate-200">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setTab(item.key);
              }}
              className={`flex-1 border-b-2 px-3 py-2 text-xs transition-colors ${
                tab === item.key
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'outline' ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {outline.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-400">
                还没有标题。用工具栏的 H1/H2/H3 建结构,这里会自动出现目录。
              </p>
            ) : (
              <ul className="space-y-0.5">
                {outline.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        scrollToHeading(item.index);
                      }}
                      className="w-full truncate rounded px-2 py-1 text-left text-xs text-slate-600 hover:bg-white"
                      style={{ paddingLeft: `${String((item.level - 1) * 12 + 8)}px` }}
                      title={item.text}
                    >
                      {item.text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <CommentsPanel nodeId={nodeId} />
        )}
      </aside>
    </div>
  );
}
