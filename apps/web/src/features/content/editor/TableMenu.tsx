/**
 * 表格菜单(v2.10)。
 *
 * ## 为什么是"一个菜单"而不是"工具栏上多排按钮"
 *
 * 用户反馈「表格默认三行三列,不支持扩展」。要补的能力有十来个
 * (插行/插列/删行/删列/合并/拆分/表头/删表 × 前后左右)——
 * 直接铺成一行按钮,在**这个布局里**放不下:正文列只有
 * `1084 - 320(左树) - 320(右栏) ≈ 444px`,工具栏会折成三行
 * (v2.8 已经因为折行踩过一次)。
 *
 * 所以收进一个菜单:不在表格里时它只做"插入"(带网格选择行列数);
 * 光标进了表格,同一个按钮变成高亮,菜单里多出「表格工具」一组。
 * **一个按钮、两种状态** —— 比铺一排按钮省地方,也不会让工具栏忽宽忽窄。
 *
 * ## ⚠️ 菜单里的按钮一律 `onMouseDown` + `preventDefault()`
 *
 * 与工具栏其它按钮同一个理由:点按钮会把焦点从编辑器抢走、选区随之丢失,
 * 于是"给这个单元格插一行"会变成"在最外层插一行"。
 * 阻止默认行为就能保住选区 —— 菜单里的按钮**每一个**都要,漏一个就那一处失灵。
 */
import type { Editor } from '@tiptap/core';
import { useState, type MouseEvent } from 'react';

import { POPOVER_CLASS, useDismiss } from './popover';

/** 插入网格的最大行列数。再大就该用"插入后加行列"而不是一次画满。 */
const GRID_MAX = 6;
const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 3;

export function TableMenu({ editor, triggerClass }: { editor: Editor; triggerClass: string }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null);

  const inTable = editor.isActive('table');
  const ref = useDismiss(open, () => {
    setOpen(false);
  });

  const guard = (action: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    action();
    // 菜单**不自动关**:连着点"下方插行"三次是常见操作。
    // 只有删除表格才关(那个动作之后菜单里的按钮全都没意义了)。
  };

  const canMerge = inTable && editor.can().chain().mergeCells().run();
  const canSplit = inTable && editor.can().chain().splitCell().run();

  function insertTable(rows: number, cols: number): void {
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setOpen(false);
  }

  /** 菜单里的一个小按钮。`disabled` 时给 title 说明原因,而不是让它静默失效。 */
  const item = (
    label: string,
    action: () => void,
    options: { disabled?: boolean; danger?: boolean; title?: string } = {},
  ) => (
    <button
      key={label}
      type="button"
      disabled={options.disabled ?? false}
      title={options.title ?? label}
      onMouseDown={guard(action)}
      className={`flex h-7 items-center justify-center rounded-md border px-2 text-xs whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        options.danger === true
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-slate-200 text-slate-700 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={inTable ? '表格工具(插入 / 删除行列、合并、表头)' : '插入表格'}
        aria-expanded={open}
        onMouseDown={(event) => {
          event.preventDefault();
          setOpen((prev) => !prev);
          setHover(null);
        }}
        className={`${triggerClass} ${inTable ? 'bg-slate-900 text-white' : ''}`}
      >
        表格
        <span className="ml-0.5 text-xs">▾</span>
      </button>

      {open && (
        <div className={`${POPOVER_CLASS} right-0 w-72 space-y-3`}>
          <div>
            <p className="mb-2 text-xs text-slate-500">
              插入表格 —— 拖动选择大小,默认 {DEFAULT_ROWS} × {DEFAULT_COLS}
            </p>

            <div
              className="inline-grid gap-0.5"
              style={{ gridTemplateColumns: `repeat(${String(GRID_MAX)}, minmax(0, 1fr))` }}
              onMouseLeave={() => {
                setHover(null);
              }}
            >
              {Array.from({ length: GRID_MAX * GRID_MAX }, (_, index) => {
                const rows = Math.floor(index / GRID_MAX) + 1;
                const cols = (index % GRID_MAX) + 1;
                const picked = hover !== null && rows <= hover.rows && cols <= hover.cols;
                const isDefault = rows === DEFAULT_ROWS && cols === DEFAULT_COLS;

                return (
                  <button
                    key={`${String(rows)}-${String(cols)}`}
                    type="button"
                    aria-label={`插入 ${String(rows)} 行 ${String(cols)} 列表格`}
                    onMouseEnter={() => {
                      setHover({ rows, cols });
                    }}
                    onMouseDown={guard(() => {
                      insertTable(rows, cols);
                    })}
                    className={`h-4 w-4 rounded-sm border transition-colors ${
                      picked
                        ? 'border-blue-500 bg-blue-100'
                        : isDefault
                          ? 'border-slate-300 bg-slate-50'
                          : 'border-slate-200 bg-white'
                    }`}
                  />
                );
              })}
            </div>

            <p className="mt-2 text-xs text-slate-600">
              {hover === null
                ? `${String(DEFAULT_ROWS)} × ${String(DEFAULT_COLS)}`
                : `${String(hover.rows)} × ${String(hover.cols)}`}
            </p>
          </div>

          {inTable && (
            <div className="space-y-2 border-t border-slate-200 pt-3">
              <p className="text-xs text-slate-500">表格工具(光标在哪一格就作用于哪一格)</p>

              <div className="grid grid-cols-2 gap-1.5">
                {item('上方插行', () => {
                  editor.chain().focus().addRowBefore().run();
                })}
                {item('下方插行', () => {
                  editor.chain().focus().addRowAfter().run();
                })}
                {item('左侧插列', () => {
                  editor.chain().focus().addColumnBefore().run();
                })}
                {item('右侧插列', () => {
                  editor.chain().focus().addColumnAfter().run();
                })}
                {item(
                  '删除本行',
                  () => {
                    editor.chain().focus().deleteRow().run();
                  },
                  { danger: true },
                )}
                {item(
                  '删除本列',
                  () => {
                    editor.chain().focus().deleteColumn().run();
                  },
                  { danger: true },
                )}
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {item(
                  '合并单元格',
                  () => {
                    editor.chain().focus().mergeCells().run();
                  },
                  {
                    disabled: !canMerge,
                    title: canMerge ? '合并选中的多个单元格' : '先用鼠标拖选两个以上单元格',
                  },
                )}
                {item(
                  '拆分单元格',
                  () => {
                    editor.chain().focus().splitCell().run();
                  },
                  {
                    disabled: !canSplit,
                    title: canSplit ? '把合并过的单元格拆开' : '当前单元格没有被合并',
                  },
                )}
                {item('切换首行表头', () => {
                  editor.chain().focus().toggleHeaderRow().run();
                })}
                {item('切换首列表头', () => {
                  editor.chain().focus().toggleHeaderColumn().run();
                })}
              </div>

              <div className="border-t border-slate-200 pt-2">
                {item(
                  '删除整个表格',
                  () => {
                    editor.chain().focus().deleteTable().run();
                    setOpen(false);
                  },
                  { danger: true, title: '整张表一起删掉,不可撤销(用 Ctrl+Z 可恢复)' },
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
