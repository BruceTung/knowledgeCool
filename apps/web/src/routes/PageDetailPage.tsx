import { can, type PageDetail } from '@knowledgecool/shared';
import type { Editor } from '@tiptap/core';
import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, ErrorNote } from '../components/ui';
import { CommentsPanel } from '../features/comments/CommentsPanel';
import { useComments } from '../features/comments/queries';
import {
  PageEditor,
  SaveStateLabel,
  type OutlineItem,
  type SaveState,
} from '../features/content/PageEditor';
import { useExportMarkdown, usePageContent } from '../features/content/queries';
import { usePageDetail, usePageTree, useUpdatePage } from '../features/pages/queries';
import { PermissionsDialog } from '../features/permissions/PermissionsDialog';

type RightTab = 'outline' | 'comments';

/**
 * 文档页 —— 唯一的主工作面(DESIGN.md §7.2)。
 *
 * 布局:面包屑 + 标题 + 正文(左) / 目录·评论(右)。
 * 高频动作是「找到一篇 → 读 → 改」,所以任何额外的导航层级都是成本。
 */
export function PageDetailPage() {
  const { spaceId, pageId } = useParams<{ spaceId: string; pageId: string }>();

  if (spaceId === undefined || pageId === undefined) {
    return <p className="p-8 text-sm text-slate-500">缺少页面标识。</p>;
  }
  return <PageDetailView spaceId={spaceId} pageId={pageId} />;
}

function PageDetailView({ spaceId, pageId }: { spaceId: string; pageId: string }) {
  const detail = usePageDetail(pageId);
  const content = usePageContent(pageId);
  const tree = usePageTree(spaceId);
  const updatePage = useUpdatePage(spaceId);
  const comments = useComments(pageId);
  const exportMd = useExportMarkdown();

  // 权限弹窗是管理员才有的入口。查询只在打开时才跑 —— 免得普通成员每开一篇都发一次请求。
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const isSpaceAdmin = can(tree.data?.role ?? 'viewer', 'page.permission.update');

  // 切换页面要重建编辑器(见 PageEditor 顶部关于「content 只在挂载时读一次」的说明)。
  // 用 `key` 控制重建,而不是靠 props 更新 —— 后者会把正在输入的内容重置掉。
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [tab, setTab] = useState<RightTab>('outline');
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [editorRef, setEditorRef] = useState<Editor | null>(null);

  const canEdit = can(tree.data?.role ?? 'viewer', 'page.edit');

  // 这两个回调要稳定,否则 PageEditor 里的 effect 每次渲染都会重跑
  const handleOutline = useCallback((items: OutlineItem[]) => {
    setOutline(items);
  }, []);
  const handleSaveState = useCallback((state: SaveState) => {
    setSaveState(state);
  }, []);
  const handleReady = useCallback((instance: Editor) => {
    setEditorRef(instance);
  }, []);

  const openCount = comments.data?.openCount ?? 0;
  const tabs = useMemo(
    () =>
      [
        { key: 'outline' as const, label: `目录${outline.length > 0 ? ` (${String(outline.length)})` : ''}` },
        { key: 'comments' as const, label: `评论${openCount > 0 ? ` (${String(openCount)})` : ''}` },
      ] satisfies { key: RightTab; label: string }[],
    [outline.length, openCount],
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

  const page: PageDetail = detail.data;

  function commitTitle(value: string) {
    setTitleDraft(null);
    const next = value.trim();
    if (next === '' || next === page.title) return;
    updatePage.mutate({ pageId: page.id, title: next, version: page.version });
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
            <Link to={`/s/${spaceId}`} className="hover:text-slate-600">
              空间首页
            </Link>
            {page.breadcrumb.map((crumb) => (
              <span key={crumb.id} className="flex items-center gap-1">
                <span>/</span>
                <Link to={`/s/${spaceId}/p/${crumb.id}`} className="hover:text-slate-600">
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
                  defaultValue={page.title}
                  className="w-full rounded-md border border-blue-400 px-2 py-1 text-2xl font-semibold outline-none"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitTitle(event.currentTarget.value);
                    if (event.key === 'Escape') setTitleDraft(null);
                  }}
                  onBlur={(event) => commitTitle(event.target.value)}
                />
              ) : (
                <h1
                  className={`text-2xl font-semibold text-slate-900 ${
                    canEdit ? 'cursor-text rounded-md px-2 py-1 hover:bg-slate-50' : 'px-2 py-1'
                  }`}
                  title={canEdit ? '点击可改名' : undefined}
                  onClick={() => {
                    if (canEdit) setTitleDraft(page.title);
                  }}
                >
                  {page.title}
                </h1>
              )}

              <div className="flex flex-wrap items-center gap-3 px-2 text-xs text-slate-400">
                <SaveStateLabel state={saveState} />
                <span>更新于 {new Date(page.updatedAt).toLocaleString('zh-CN')}</span>
                {page.status !== 'published' && (
                  <span>{page.status === 'draft' ? '草稿' : '已归档'}</span>
                )}
              </div>
            </div>

            <div className="flex flex-none items-center gap-2 pt-1">
              {isSpaceAdmin && (
                <Button variant="secondary" onClick={() => setPermissionsOpen(true)}>
                  权限
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={exportMd.isPending}
                title="导出为 Markdown 文件"
                onClick={() => {
                  exportMd.mutate({ pageId: page.id, title: page.title });
                }}
              >
                {exportMd.isPending ? '导出中…' : '导出 MD'}
              </Button>
            </div>
          </div>

          {updatePage.isError && (
            <div className="mt-2 px-2">
              <ErrorNote error={updatePage.error} />
            </div>
          )}
          {exportMd.isError && (
            <div className="mt-2 px-2">
              <ErrorNote error={exportMd.error} />
            </div>
          )}
        </header>

        <PageEditor
          key={pageId}
          pageId={pageId}
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
          <CommentsPanel pageId={pageId} spaceId={spaceId} role={tree.data?.role ?? 'viewer'} />
        )}
      </aside>

      {permissionsOpen && (
        <PermissionsDialog
          pageId={page.id}
          spaceId={spaceId}
          onClose={() => {
            setPermissionsOpen(false);
          }}
        />
      )}
    </div>
  );
}
