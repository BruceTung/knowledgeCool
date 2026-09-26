import type { SearchHit } from '@knowledgecool/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { useSearch } from '../features/search/queries';

/**
 * 检索结果页(DESIGN.md §7.2 的 `/search`)。
 *
 * 与 `Cmd+K` 面板共用同一个接口与同一份权限过滤 ——
 * 两条入口给出的结果必须完全一致,否则会出现"面板里搜得到、结果页搜不到"
 * 这种让人怀疑系统坏了的差异。
 */
export function SearchPage() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [spaceId, setSpaceId] = useState('');

  const search = useSearch(query, spaceId === '' ? undefined : spaceId);

  function submit(event: FormEvent) {
    event.preventDefault();
    setQuery(input);
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="text-lg font-semibold text-slate-900">检索</h1>
      <p className="mt-1 text-xs text-slate-500">
        结果按你的权限过滤后返回 —— 你看不到的文档不会出现在这里,也不会影响命中条数。
      </p>

      <form className="mt-4 flex flex-wrap gap-2" onSubmit={submit}>
        <input
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          placeholder="输入关键词(中文可直接搜)"
          className="min-w-[200px] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
        <input
          value={spaceId}
          onChange={(event) => {
            setSpaceId(event.target.value.trim());
          }}
          placeholder="限定空间 id(可留空)"
          className="w-56 rounded-md border border-slate-300 px-3 py-2 text-xs outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          搜索
        </button>
      </form>

      {search.isError && (
        <div className="mt-4">
          <ErrorNote error={search.error} />
        </div>
      )}

      {query.trim() !== '' && search.data !== undefined && (
        <>
          <p className="mt-4 text-xs text-slate-400">
            「{search.data.query}」命中 {search.data.hits.length} 条 · {search.data.tookMs}ms
          </p>
          {search.data.hits.length === 0 ? (
            <p className="mt-6 text-sm text-slate-400">没有匹配的内容。</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-200">
              {search.data.hits.map((hit) => (
                <li key={hit.pageId}>
                  <ResultRow hit={hit} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {query.trim() === '' && (
        <p className="mt-6 text-sm text-slate-400">
          也可以用 <kbd className="rounded border border-slate-300 px-1 text-xs">Ctrl / Cmd + K</kbd>{' '}
          在任何页面调出命令面板。
        </p>
      )}
    </div>
  );
}

function ResultRow({ hit }: { hit: SearchHit }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        void navigate(`/s/${hit.spaceId}/p/${hit.pageId}`);
      }}
      className="block w-full py-3 text-left hover:bg-slate-50"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-800">{hit.title}</span>
        {hit.matchedIn === 'title' && (
          <span className="rounded bg-blue-50 px-1 text-[10px] text-blue-700">标题命中</span>
        )}
        <span className="ml-auto text-[11px] text-slate-400">
          {new Date(hit.updatedAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-slate-400">
        <Link to={`/s/${hit.spaceId}`} className="hover:text-slate-600" onClick={(e) => e.stopPropagation()}>
          {hit.spaceName}
        </Link>
        {hit.breadcrumb.length > 0 && ` / ${hit.breadcrumb.join(' / ')}`}
      </div>
      {hit.snippet !== '' && (
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{hit.snippet}</p>
      )}
    </button>
  );
}
