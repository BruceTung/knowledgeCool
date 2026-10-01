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

import { Modal } from '../../components/Modal';
import { useDebounced } from '../../lib/use-debounced';
import { useModalOpen } from '../../lib/modal-store';
import { T_META } from '../../lib/typography';
import { useSearch } from './queries';

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 登记为"有一个模态开着"—— 全局的 Ctrl/Cmd + K 靠它避免重复叠加。
  useModalOpen();

  // 防抖:每敲一个键就检索一次太浪费,中文输入法下还会在组合期间连发。
  const search = useSearch(useDebounced(query, 220));
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
    <Modal
      // 命令面板**不要**默认表头:它的第一行就是搜索框,上面再压一条
      // "关闭"标题栏既多余、又把输入框从第一眼的位置挤下去。
      // 关掉表头就必须给 ariaLabel —— 否则这个对话框没有可访问名。
      hideHeader
      ariaLabel="全局检索"
      onClose={onClose}
      maxWidthClass="max-w-xl"
      bodyClassName="flex max-h-[70vh] min-h-0 flex-col overflow-hidden p-0"
      footer={
        <>
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          {search.data !== undefined && (
            <span className="ml-auto">
              命中 {hits.length} 条 · {search.data.tookMs}ms
            </span>
          )}
        </>
      }
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // 换了关键词就回到第一条 —— 由输入事件负责,不用 effect
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          // Esc 由 Modal 统一处理(它在 document 的捕获阶段监听),
          // 这里不再自己处理一遍 —— 两处都关会各跑一次 onClose。
          /*
            ⚠️ **输入法组词期间的方向键与 Enter 属于输入法,不属于这个列表。**
            不判 `isComposing` 的话,中文用户每选一次候选词,↑/↓ 会把选中项挪走、
            Enter 会直接打开某个搜索结果 —— 而用户只是想把自己那个词打完。
          */
          if (event.nativeEvent.isComposing) return;
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
        className="w-full flex-none border-b border-slate-200 px-4 py-3 text-sm outline-none placeholder:text-slate-500"
      />

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {query.trim() === '' ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">
            输入关键词开始搜索。
            <br />
            你能读到的内容都会出现在这里(受限节点里读不到的部分不会出现)。
          </p>
        ) : search.isPending ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">搜索中…</p>
        ) : search.isError ? (
          /*
              ⚠️ v2.16:`isError` 必须排在 `hits.length === 0` **前面**。
              故障(500 / 网络断开)时 hits 也是空的,原来的分支顺序会把
              "搜索坏了"显示成「没有匹配的内容」—— 与结果页(`SearchPage`
              给的是 ErrorNote + 重试按钮)对同一件事给出两个相反结论,
              而用户会照着"没搜到"这个结论去换关键词继续试。
            */
          <div className="px-4 py-6 text-center text-sm text-slate-500">
            <p>搜索失败了,不是"没有匹配的内容"。</p>
            <p className="mt-1">
              {search.error instanceof Error ? search.error.message : '请稍后重试。'}
            </p>
          </div>
        ) : hits.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">没有匹配的内容</p>
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
                      <span className={`flex-none rounded bg-blue-50 px-1 text-blue-700 ${T_META}`}>
                        标题
                      </span>
                    )}
                  </span>
                  <span className="w-full truncate text-xs text-slate-500">
                    {hit.breadcrumb.length > 0 && hit.breadcrumb.join(' / ')}
                  </span>
                  {hit.snippet !== '' && (
                    <span className="w-full truncate text-sm text-slate-500">{hit.snippet}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
