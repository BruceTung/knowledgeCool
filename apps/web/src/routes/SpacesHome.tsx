import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { avatarClass, Button, ErrorNote, TextField } from '../components/ui';
import { ROLE_LABELS } from '../features/spaces/labels';
import { useCreateSpace, useSpaces } from '../features/spaces/queries';

/**
 * 全部空间(DESIGN.md §7.2 的 `/spaces`)。
 *
 * 这里就是 M2 验收标准的落点:「全新数据库启动后能创建管理员
 * **并建出第一个空间**」。所以「新建空间」必须在这个页面上一眼可见、
 * 不需要先进任何二级页面。
 */
export function SpacesHome() {
  const spaces = useSpaces();
  const createSpace = useCreateSpace();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;

    createSpace.mutate(
      { name: trimmed, ...(slug.trim() === '' ? {} : { slug: slug.trim() }) },
      {
        onSuccess: () => {
          setName('');
          setSlug('');
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="text-xl font-semibold text-slate-900">全部空间</h1>
      <p className="mt-1 text-sm text-slate-500">
        空间是知识库的顶层容器,通常一个部门或一个项目一个。你是某个空间的成员才能看到它。
      </p>

      <section className="mt-6 rounded-xl border border-slate-200 p-5">
        <h2 className="text-sm font-medium text-slate-900">新建空间</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          创建者会成为该空间的所有者与管理员。标识字与颜色不填就按名称自动推导。
        </p>

        <form onSubmit={handleSubmit} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <TextField
            label="空间名称"
            required
            maxLength={64}
            value={name}
            onChange={(e) => void setName(e.target.value)}
            placeholder="如:研发中心"
          />
          <TextField
            label="slug(可空)"
            value={slug}
            onChange={(e) => void setSlug(e.target.value)}
            placeholder="留空自动生成"
          />
          <div className="flex items-end">
            <Button type="submit" disabled={createSpace.isPending || name.trim() === ''}>
              {createSpace.isPending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>

        <div className="mt-3">
          <ErrorNote error={createSpace.error} />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-900">我加入的空间</h2>

        {spaces.isPending && <p className="mt-3 text-sm text-slate-400">加载中…</p>}
        {spaces.isError && (
          <div className="mt-3">
            <ErrorNote error={spaces.error} />
          </div>
        )}

        {spaces.data?.length === 0 && (
          <p className="mt-3 rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
            还没有任何空间。用上面的表单建第一个吧。
          </p>
        )}

        <ul className="mt-3 space-y-2">
          {spaces.data?.map((space) => (
            <li key={space.id}>
              <Link
                to={`/s/${space.id}`}
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 transition-colors hover:bg-slate-50"
              >
                <span
                  className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg text-sm ring-1 ${avatarClass(space.color)}`}
                >
                  {space.letter}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {space.name}
                  </span>
                  <span className="block text-xs text-slate-400">
                    {space.slug} · {space.memberCount} 位成员
                  </span>
                </span>
                <span className="flex-none rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                  {ROLE_LABELS[space.role]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
