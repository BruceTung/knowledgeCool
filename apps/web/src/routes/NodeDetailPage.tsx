import type { Editor } from '@tiptap/core';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

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
import { useExportMarkdown, useNodeContent, useNodeDetail, useOrgTree, useUpdateNode } from '../features/org/queries';
import { T_LABEL, T_META } from '../lib/typography';

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

/**
 * 这个节点下面的子页面(v2.8)。
 *
 * ⚠️ 为什么要有它:一个「组 / 部门」节点自身往往没有正文。打开之后如果只有一个
 * 空白编辑器,用户看到的是"这里什么都没有" —— 而它下面其实挂着好几篇文档。
 * 实测就是这么撞上的:打开「后端组」是一块白板,而「研发规范」「技术方案」
 * 都在它下面。
 *
 * Confluence 在空间首页列的就是子页面,这里同理。
 *
 * 数据直接取自**已经缓存的**组织树(`useOrgTree`)—— 树里本来就带 `parentId`,
 * 派生一次比多开一个接口划算得多,而且点进来时它通常已经在本地缓存里了。
 */
function ChildPages({ nodeId }: { nodeId: string }) {
  const tree = useOrgTree();
  const navigate = useNavigate();

  const children = useMemo(
    () =>
      (tree.data?.nodes ?? [])
        .filter((node) => node.parentId === nodeId)
        .sort((a, b) => a.position - b.position),
    [tree.data, nodeId],
  );

  // 没有子页面就什么都不渲染 —— 不要为了"结构完整"留一个空盒子
  if (children.length === 0) return null;

  return (
    <section className="mx-8 mt-6 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <h2 className={`mb-2.5 text-slate-500 ${T_LABEL}`}>子页面 · {children.length}</h2>
      <ul>
        {children.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              onClick={() => void navigate(`/n/${child.id}`)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white"
            >
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded text-xs font-medium ${
                  child.kind === 'space'
                    ? 'bg-teal-50 text-teal-700'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {child.kind === 'space' ? '组' : '页'}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                {child.title}
              </span>
              {child.commentCount > 0 && (
                <span
                  className={`flex-none rounded-full bg-slate-100 px-1.5 py-0.5 font-medium tabular-nums text-slate-500 ${T_META}`}
                >
                  {child.commentCount}
                </span>
              )}
              <span className="flex-none text-sm text-slate-400">{child.ownerName}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 更新时间的展示格式。
 *
 * 不用 `toLocaleString('zh-CN')` 的默认输出 —— 它带秒,而秒在这一行里
 * 既没有信息量、又占宽度(窄内容列下会把整个值顶到换行)。
 * 形如 `2026/9/27 02:35`。
 */
function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 离职标记。历史记录不抹掉,只在名字旁注明(v2.2)。 */
function DepartedBadge() {
  return (
    <span
      className={`rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 ring-1 ring-amber-200 ${T_META}`}
    >
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
        <header className="flex-none border-b border-slate-200 px-8 pt-5 pb-4">
          <nav className="flex flex-wrap items-center gap-1.5 text-sm text-slate-400">
            <Link to="/" className="transition-colors hover:text-slate-700">
              全部
            </Link>
            {node.breadcrumb.slice(0, -1).map((crumb) => (
              <span key={crumb.id} className="flex items-center gap-1.5">
                <span className="text-slate-300">/</span>
                <Link to={`/n/${crumb.id}`} className="transition-colors hover:text-slate-700">
                  {crumb.title}
                </Link>
              </span>
            ))}
          </nav>

          <div className="mt-2 flex items-start gap-4">
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
                  /*
                    `text-2xl`(24px)= Atlassian `font.heading.large`(Bold 24 / 28)。
                    上一轮我把它压到 20px,理由是"24px 配 12px 的元信息落差太大" ——
                    那是**拿错的那一头去迁就**:真正该改大的是元信息(12 → 14),
                    而不是把标题压小。
                  */
                  className={`text-2xl font-semibold tracking-tight text-slate-900 ${
                    canEdit ? 'cursor-text rounded-md px-2 py-0.5 hover:bg-slate-50' : 'px-2 py-0.5'
                  }`}
                  title={canEdit ? '点击可改名' : undefined}
                  onClick={() => {
                    if (canEdit) setTitleDraft(node.title);
                  }}
                >
                  {node.title}
                </h1>
              )}
            </div>

            <div className="flex flex-none items-center gap-2 pt-1.5">
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

          {/*
            元信息行放在**标题那一行的外面**,占满整个页头宽度。

            ⚠️ 原来它嵌在标题的 `flex-1` 容器里,于是右侧那排按钮
            (成员 / 权限 / 导出 MD,合计约 220px)会把它挤到只剩一百多 px ——
            「所有者 王思远」「创建者 林晗」「更新于 …」被迫**各占一行**,
            页头凭空高出三行。这不是字号问题,是**谁和谁抢同一行**的问题。

            每一项都 `whitespace-nowrap`:实测「更新于 2026/9/27 02:35:15」
            会在日期与时间之间折行,同一个值被拆开是最难看的排版之一。
            顺带去掉秒 —— 它没有信息量,却让这一行多占 30px。
          */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 px-2 text-sm text-slate-500">
            <SaveStateLabel state={saveState} />
            <span className="whitespace-nowrap">
              所有者 <span className="text-slate-700">{node.ownerName}</span>
              {node.ownerDeparted && <DepartedBadge />}
            </span>
            <span className="whitespace-nowrap">
              创建者 <span className="text-slate-700">{node.createdByName}</span>
              {node.createdByDeparted && <DepartedBadge />}
            </span>
            <span className="whitespace-nowrap text-slate-400">
              更新于 {formatUpdatedAt(node.updatedAt)}
            </span>
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

        {/* 有子页面就先列出来 —— 组 / 部门节点通常自身没有正文(见 `ChildPages`) */}
        <ChildPages nodeId={nodeId} />

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
        {/*
          右栏是**组件**,它的标签走 14px + Medium 字重(Atlassian 的 `font.body` 档,
          官方原话:"组件里用 14px;配合图标时用 Medium")。
          tab 高度给到 44px —— 它是要被**点**的东西,不是一行说明文字。
        */}
        <div className="flex flex-none items-stretch border-b border-slate-200 px-1">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setTab(item.key);
              }}
              className={`flex-1 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                tab === item.key
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'outline' ? (
          <div className="min-h-0 flex-1 overflow-auto px-2 py-3">
            {outline.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm leading-relaxed text-slate-400">
                  这一页还没有标题。
                </p>
                <p className={`mt-2 leading-relaxed text-slate-400 ${T_META}`}>
                  用工具栏的 H1 / H2 / H3 建出结构,目录会自动出现在这里。
                </p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {outline.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        scrollToHeading(item.index);
                      }}
                      /*
                        目录项 = 内容档 14px(Atlassian `font.body`),不是 12px。
                        它是**要被读、被点**的导航项;缩进按层级每级 16px,
                        这样 14px 的字能看出层级差。
                      */
                      className="w-full truncate rounded-md py-1.5 pr-2 text-left text-sm leading-5 text-slate-600 transition-colors hover:bg-white hover:text-slate-900"
                      style={{ paddingLeft: `${String((item.level - 1) * 16 + 12)}px` }}
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
