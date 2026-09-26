import { Link, useParams } from 'react-router-dom';

import { avatarClass, ErrorNote } from '../components/ui';
import { ROLE_HINTS, ROLE_LABELS } from '../features/spaces/labels';
import { useSpaces } from '../features/spaces/queries';

/**
 * 空间概览(DESIGN.md §7.2 的 `/s/:spaceId`)。
 *
 * M3 会把这里换成「页面树 + 编辑器」的主工作面 —— 那时只换组件,
 * 不动路由。所以现在先把这层壳立起来,让它成为一个真实存在的落点,
 * 而不是让侧栏直接跳到二级页面。
 */
export function SpaceOverviewPage() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const spaces = useSpaces();

  const space = spaces.data?.find((item) => item.id === spaceId);

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      {spaces.isPending && <p className="text-sm text-slate-400">加载中…</p>}

      {spaces.isError && <ErrorNote error={spaces.error} />}

      {spaces.isSuccess && space === undefined && (
        <p className="text-sm text-slate-500">空间不存在,或你没有访问权限。</p>
      )}

      {space !== undefined && (
        <>
          <div className="flex items-center gap-3">
            <span
              className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl text-base ring-1 ${avatarClass(space.color)}`}
            >
              {space.letter}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-slate-900">{space.name}</h1>
              <p className="text-xs text-slate-400">
                {space.slug} · {space.memberCount} 位成员 · 我是
                {ROLE_LABELS[space.role]}
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-medium text-slate-900">我在这个空间里的权限</h2>
            <p className="mt-1 text-sm text-slate-600">{ROLE_HINTS[space.role]}</p>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Link
              to={`/s/${space.id}/members`}
              className="rounded-xl border border-slate-200 p-5 transition-colors hover:bg-slate-50"
            >
              <div className="text-sm font-medium text-slate-900">成员管理</div>
              <div className="mt-0.5 text-xs text-slate-400">
                邀请成员、调整角色、移除成员
              </div>
            </Link>

            <div className="rounded-xl border border-dashed border-slate-200 p-5">
              <div className="text-sm font-medium text-slate-400">正文编辑器</div>
              <div className="mt-0.5 text-xs text-slate-400">
                M4 落地。届时点开页面就能在左侧那棵树旁边直接写正文。
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
