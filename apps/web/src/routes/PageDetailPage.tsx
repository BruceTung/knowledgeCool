import { can, type PageDetail } from '@knowledgecool/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { usePageDetail, usePageTree, useUpdatePage } from '../features/pages/queries';

/**
 * 页面详情(DESIGN.md §7.2 的 `/s/:spaceId/p/:pageId`)。
 *
 * M3 这里只有元信息与可编辑标题 —— **正文编辑器是 M4 的**
 * (page_contents + Tiptap)。先把这个页面立起来,是因为树上的每一次点击
 * 都需要有个落点,M4 只往中间填内容,不动路由。
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
  const tree = usePageTree(spaceId);
  const updatePage = useUpdatePage(spaceId);

  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  // 权限只决定能不能编辑;服务端仍是唯一裁判
  const canEdit = can(tree.data?.role ?? 'viewer', 'page.edit');

  if (detail.isPending) return <p className="p-8 text-sm text-slate-400">加载中…</p>;
  if (detail.isError) {
    return (
      <div className="p-8">
        <ErrorNote error={detail.error} />
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

  return (
    <article className="mx-auto max-w-3xl px-8 py-8">
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

      {titleDraft !== null ? (
        <input
          autoFocus
          defaultValue={page.title}
          className="mt-2 w-full rounded-md border border-blue-400 px-2 py-1 text-2xl font-semibold outline-none"
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitTitle(event.currentTarget.value);
            if (event.key === 'Escape') setTitleDraft(null);
          }}
          onBlur={(event) => commitTitle(event.target.value)}
        />
      ) : (
        <h1
          className={`mt-2 text-2xl font-semibold text-slate-900 ${
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

      <div className="mt-2 flex flex-wrap items-center gap-3 px-2 text-xs text-slate-400">
        <span>深度 {page.depth}</span>
        <span>·</span>
        <span>版本 v{page.version}</span>
        <span>·</span>
        <span>
          {page.status === 'published' ? '已发布' : page.status === 'draft' ? '草稿' : '已归档'}
        </span>
        <span>·</span>
        <span>更新于 {new Date(page.updatedAt).toLocaleString('zh-CN')}</span>
      </div>

      {updatePage.isError && (
        <div className="mt-4">
          <ErrorNote error={updatePage.error} />
        </div>
      )}

      <div className="mt-8 rounded-xl border border-dashed border-slate-200 p-8 text-center">
        <p className="text-sm text-slate-400">正文编辑器在 M4 落地</p>
        <p className="mt-1 text-xs text-slate-400">
          届时这里会是 Tiptap 编辑器,正文以 ProseMirror 文档树存进 page_contents
          —— 结构上已经为阶段二的协同预留好了。
        </p>
      </div>
    </article>
  );
}
