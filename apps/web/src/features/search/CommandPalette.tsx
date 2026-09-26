/**
 * 全局检索面板(Ctrl / Cmd + K)—— DESIGN.md §7.2:
 * 「全局检索是 Cmd/Ctrl + K 命令面板,不占版面」。
 *
 * 三条交互细节值得说明:
 *
 * 1. **输入时不重建输入框**。第一版把整个面板 `innerHTML` 重建再 `focus()`,
 *    中文输入法会被打断 —— 每敲一个字母就重置一次组合状态,根本打不出字。
 *    现在搜索框是受控的独立元素,输入只触发查询,不重建 DOM。
 * 2. **上下键 + 回车**必须能用。命令面板的老用户不会去点鼠标。
 * 3. **只在打开时挂载**(父组件用条件渲染),不接收 `open` 开关。
 *    这样关闭时状态自然清空,而且不需要「在 effect 里 setState 重置」——
 *    那种写法会触发级联渲染。
 */
import type { SearchHit } from '@knowledgecool/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useSearch } from './queries';

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const search = useSearch(query);
  const hits: SearchHit[] = search.data?.hits ?? [];

  // 挂载后聚焦。必须等一帧:面板还在渲染中,立刻 focus 会被丢掉。
  useEffect(() => {
    const handle = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(handle);
    };
  }, []);

  // 命中数变少时把选中项夹回合法范围,而不是用 effect 去重置它
  const safeIndex = hits.length === 0 ? 0 : Math.min(activeIndex, hits.length - 1);

  function go(hit: SearchHit) {
    navigate(`/n/${hit.nodeId}`);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/20 p-6 pt-24">
      <div className="absolute inset-0" onClick={onClose} role="presentation" />

      <section className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // 换了关键词就回到第一条 —— 由输入事件负责,不用 effect
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex(hits.length === 0 ? 0 : (safeIndex + 1) % hits.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex(hits.length === 0 ? 0 : (safeIndex - 1 + hits.length) % hits.length);
              return;
            }
            if (event.key === 'Enter') {
              const hit = hits[safeIndex];
              if (hit !== undefined) go(hit);
            }
          }}
          placeholder="搜索页面标题与正文…(中文可直接搜)"
          className="w-full border-b border-slate-200 px-4 py-3 text-sm outline-none placeholder:text-slate-400"
        />

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {query.trim() === '' ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              输入关键词开始搜索。
              <br />
              全公司可读的内容都会出现在这里 —— 系统不区分"能搜到"与"能打开"。
            </p>
          ) : search.isPending ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">搜索中…</p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">没有匹配的内容</p>
          ) : (
            <ul>
              {hits.map((hit, index) => (
                <li key={hit.nodeId}>
                  <button
                    type="button"
                    onMouseEnter={() => {
                      setActiveIndex(index);
                    }}
                    onClick={() => {
                      go(hit);
                    }}
                    className={`flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left ${
                      index === safeIndex ? 'bg-slate-100' : ''
                    }`}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                        {hit.title}
                      </span>
                      {hit.matchedIn === 'title' && (
                        <span className="flex-none rounded bg-blue-50 px-1 text-[10px] text-blue-700">
                          标题
                        </span>
                      )}
                    </span>
                    <span className="w-full truncate text-[11px] text-slate-400">
                      {hit.breadcrumb.length > 0 && hit.breadcrumb.join(' / ')}
                    </span>
                    {hit.snippet !== '' && (
                      <span className="w-full truncate text-[11px] text-slate-500">
                        {hit.snippet}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex flex-none items-center gap-3 border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          {search.data !== undefined && (
            <span className="ml-auto">
              命中 {hits.length} 条 · {search.data.tookMs}ms
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}
