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
import { ApiError } from '../../lib/api';
import { useDebounced } from '../../lib/use-debounced';
import { useModalOpen } from '../../lib/modal-store';
import { T_META } from '../../lib/typography';
import { useSearch } from './queries';

/**
 * 结果列表的 id。`aria-controls` 要指向它 —— 一个常量就够了:
 * 同一时刻只会有一个命令面板打开。
 */
const LISTBOX_ID = 'kc-command-palette-listbox';

/**
 * 每一项的 id。`aria-activedescendant` 需要的是**元素 id**,
 * 所以用 `hit.nodeId`(UUID,天然唯一)而**不是数组下标** ——
 * 下标会随结果集变化而指向另一条,读屏会念错项。
 */
function optionIdOf(hit: SearchHit | undefined): string | undefined {
  return hit === undefined ? undefined : `kc-cp-option-${hit.nodeId}`;
}

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
      {/*
        ⚠️⚠️ v4.35:补上 combobox / listbox 的语义。
        
        这个输入框**驱动着一个列表**(↑/↓ 移动高亮、Enter 打开当前项),
        但原来它在无障碍上只是一只**裸文本框**:
        · 输入框没有 `role="combobox"`,读屏不知道它连着列表;
        · 没有 `aria-expanded` —— 读屏不知道列表是开是关;
        · 没有 `aria-controls` / `aria-activedescendant` ——
        **焦点始终在输入框上**(这是 combobox 的正确做法),
        所以必须靠 `aria-activedescendant` 告诉读屏「当前选中哪一项」;
        · 列表是普通 `<ul>`/`<li>`,高亮项只有背景色 ——
        没有任何 `aria-selected`,读屏完全听不到 ↑/↓ 有没有动。
        
        后果:读屏用户按 ↑/↓,屏幕上一个字的反馈都没有 ——
        他不知道有几条结果、现在停在第几条、Enter 会打开哪一个。
        
        ⚠️ `aria-activedescendant` 的值必须是**元素的 id**,
        所以每项要有稳定 id。用 `hit.nodeId`(UUID,天然唯一),
        而不是数组下标 —— 下标会随结果变化而指向别的项。
      */}
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
        /* ⚠️ v4.33：placeholder 不能当无障碍名。 */
        aria-label="搜索页面标题与正文"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={hits.length > 0 ? optionIdOf(hits[safeIndex]) : undefined}
        className="w-full flex-none border-b border-slate-200 px-4 py-3 text-sm outline-none placeholder:text-slate-500"
      />

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {query.trim() === '' ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">
            输入关键词开始搜索。
            <br />
            你能读到的内容都会出现在这里(受限节点里读不到的部分不会出现)。
          </p>
        ) : search.isFetching && search.isPlaceholderData ? (
          /*
            ⚠️ v5.45(P0 修复):原来是 `search.isPending`。
            =
            `keepPreviousData` 会让 `data` 非空,于是 `isPending` **恒为 false**
            —— 这一支「搜索中…」**从来没有执行过**。结果是每次改词之后,
            旧结果继续挂在列表里,而且 `aria-activedescendant` 指向的也是旧项,
            键盘用户按 ↑↓ 会在"上一批结果"里选。

            → 改用 `isFetching && isPlaceholderData`:两者同时为真
            精确表示"正在取新数据、界面上还是旧数据"这一段窗口。
          */
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
              {/*
                ⚠️ v4.42:与 ErrorNote 同一个坑 —— 不能用 instanceof Error 取 message。
                网络失败时那是浏览器的英文原文(Failed to fetch),不该摆给中文用户看。
              */}
              {search.error instanceof ApiError
                ? search.error.message
                : '请求没有送达服务器。请检查网络,或稍后重试。'}
            </p>
          </div>
        ) : hits.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">没有匹配的内容</p>
        ) : (
          /*
            ⚠️ v4.35:列表要有 listbox / option 语义。

            配合输入框上的 `aria-activedescendant` 才完整:
            焦点留在输入框,读屏靠「当前激活的是哪个 option」来播报。
            没有 `role="listbox"` / `role="option"` 的话,`aria-activedescendant`
            指向的 id 落在普通 `<ul>`/`<li>` 上,读屏**不认**。
          */
          <ul id={LISTBOX_ID} role="listbox" aria-label="搜索结果">
            {hits.map((hit, index) => (
              <li key={hit.nodeId}>
                <button
                  type="button"
                  id={optionIdOf(hit)}
                  role="option"
                  /*
                    `aria-selected` 是「当前高亮项」的**唯一**无障碍表达 ——
                    原来只有 `bg-slate-100` 一个背景色,读屏完全听不到 ↑/↓ 动没动。
                  */
                  aria-selected={index === safeIndex}
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
