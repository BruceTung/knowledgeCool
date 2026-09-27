import type { SearchHit } from '@knowledgecool/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { useSearch } from '../features/search/queries';
import { splitByQuery } from '../lib/highlight';
import { usePersonal } from '../lib/personal-store';
import { T_META } from '../lib/typography';

/**
 * 检索结果页(DESIGN.md §7.2 的 `/search`)。
 *
 * 与 `Cmd+K` 面板共用同一个接口 —— 两条入口给出的结果必须完全一致,
 * 否则会出现"面板里搜得到、结果页搜不到"这种让人怀疑系统坏了的差异。
 *
 * ⚠️ 两处易变的历史:
 *   · v2.0 起**没有"限定空间"输入框**了 —— 空间与页面已合并成一棵树。
 *   · v2.13 起**又要按权限过滤**了:有了受限节点,"树上和检索里都是全集"
 *     这句话不再成立。过滤在服务端(见 `SearchService`),前端拿到的已是他能看的。
 *     少了它,受限文档的标题与正文片段会出现在全公司的搜索结果里 ——
 *     而保密功能**看起来完全正常**。
 */
export function SearchPage() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  const search = useSearch(query);

  const history = usePersonal((state) => state.history);
  const rememberSearch = usePersonal((state) => state.rememberSearch);
  const clearHistory = usePersonal((state) => state.clearHistory);

  function submit(event: FormEvent) {
    event.preventDefault();
    setQuery(input);
    // 只记**真正提交过的**词,不记每一次按键 —— 否则历史里全是被删掉的半截词
    rememberSearch(input);
  }


  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="text-lg font-semibold text-slate-900">检索</h1>
      <p className="mt-1 text-sm text-slate-500">
        搜的是标题与正文,中文可直接搜。全公司可读的内容都能搜到。
      </p>

      <form className="mt-4 flex gap-2" onSubmit={submit}>
        <input
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          placeholder="输入关键词(中文可直接搜)"
          className="min-w-[200px] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          搜索
        </button>
      </form>

      {/*
        检索历史(v2.14)。只在没有正在看的结果时出现 —— 有结果时它会把结果往下推,
        而那时候用户已经找到东西了,历史帮不上忙。
      */}
      {query.trim() === '' && history.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className={`text-slate-500 ${T_META}`}>最近搜过</span>
          {history.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => {
                setInput(term);
                setQuery(term);
              }}
              className="rounded bg-slate-100 px-2 py-0.5 text-sm text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900"
            >
              {term}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              clearHistory();
            }}
            className={`ml-1 rounded px-1.5 py-0.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 ${T_META}`}
          >
            清除
          </button>
        </div>
      )}

      {search.isError && (
        <div className="mt-4">
          <ErrorNote
            error={search.error}
            onRetry={() => {
              void search.refetch();
            }}
          />
        </div>
      )}

      {query.trim() !== '' && search.data !== undefined && (
        <>
          <p className="mt-4 text-sm text-slate-500">
            「{search.data.query}」命中 {search.data.hits.length} 条 · {search.data.tookMs}ms
          </p>
          {search.data.hits.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">没有匹配的内容。</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-200">
              {search.data.hits.map((hit) => (
                <li key={hit.nodeId}>
                  <ResultRow hit={hit} query={search.data.query} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {query.trim() === '' && (
        <p className="mt-6 text-sm text-slate-500">
          也可以用 <kbd className="rounded border border-slate-300 px-1 text-xs">Ctrl / Cmd + K</kbd>{' '}
          在任何页面调出命令面板。
        </p>
      )}
    </div>
  );
}

/**
 * 把命中的词包成 `<mark>`(v2.14)。
 *
 * 用原生 `<mark>` 而不是自己画一个 span:它自带语义(屏幕阅读器会念成"标记"),
 * 而且浏览器默认就给它黄底。我们只覆盖颜色以贴合这套配色。
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitByQuery(text, query).map((segment, index) =>
        segment.hit ? (
          <mark
            key={index}
            className="rounded bg-amber-100 px-0.5 text-slate-900"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function ResultRow({ hit, query }: { hit: SearchHit; query: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        void navigate(`/n/${hit.nodeId}`);
      }}
      className="block w-full py-3 text-left hover:bg-slate-50"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-800">
          <Highlighted text={hit.title} query={query} />
        </span>
        {hit.matchedIn === 'title' && (
          <span className={`rounded bg-blue-50 px-1 text-blue-700 ${T_META}`}>标题命中</span>
        )}
        <span className={`ml-auto text-slate-500 text-xs`}>
          {new Date(hit.updatedAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
      {hit.breadcrumb.length > 0 && (
        <div className="mt-0.5 text-xs text-slate-500">{hit.breadcrumb.join(' / ')}</div>
      )}
      {hit.snippet !== '' && (
        <p className="mt-1 line-clamp-2 text-sm text-slate-500">
          <Highlighted text={hit.snippet} query={query} />
        </p>
      )}
    </button>
  );
}
