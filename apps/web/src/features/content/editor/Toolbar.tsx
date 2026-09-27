/**
 * 编辑器工具栏(v2.10 拆出)。
 *
 * 原来这一坨挤在 `PageEditor.tsx` 里,加上链接气泡、表格菜单、语言下拉之后
 * 会把那个文件推到 700 行 —— 那些部件与"自动保存 / 冲突处理"没有关系,
 * 拆开之后 `PageEditor.tsx` 只剩"编辑器本身的生命周期"。
 *
 * ## 上下文相关的一行
 *
 * 光标在代码块里时,工具栏右端出现语言下拉。它**不占一整行**:
 * 正文列在这个布局里只有 400 多 px(v2.8 因此折过三行),所以能塞进一行
 * 就塞进一行。表格的操作项更多,收进「表格」菜单(见 `TableMenu`),
 * 而不是铺一排按钮。
 */
import type { Editor } from '@tiptap/core';
import type { MouseEvent } from 'react';

import { CodeLanguageSelect } from './CodeLanguageSelect';
import { LinkPopover } from './LinkPopover';
import { TableMenu } from './TableMenu';

/**
 * 工具栏按钮的统一规格。
 *
 * ⚠️ 原来文字按钮(链接 / 图片 / 表格)没写 `min-w`,而符号按钮写了 ——
 * 于是一行里按钮宽度参差。再加上按钮高度是"内边距撑出来的",
 * 分隔线(`h-4`)与按钮的视觉中线也对不齐。
 * 用户反馈的「图标、字体大小、字样都不对称」,这一排是主要来源之一。
 *
 * 收敛成常量:固定高度 + 最小宽度 + 居中对齐,新增按钮不会再各写一份。
 */
const TOOL_BUTTON_CLASS =
  'flex h-7 min-w-[32px] items-center justify-center rounded-md px-2 text-sm leading-none transition-colors';
const TOOL_BUTTON_IDLE_CLASS = 'text-slate-600 hover:bg-slate-100 hover:text-slate-900';
const TOOL_BUTTON_ACTIVE_CLASS = 'bg-slate-900 text-white';
const TOOL_DIVIDER_CLASS = 'mx-1.5 h-4 w-px bg-slate-200';

export function EditorToolbar({
  editor,
  onPickImage,
  imageUploading,
}: {
  editor: Editor;
  onPickImage: () => void;
  imageUploading: boolean;
}) {
  /**
   * ⚠️ 用 `onMouseDown` 而不是 `onClick`,并且 `preventDefault()`。
   * 点按钮会先把焦点从编辑器抢走,选区随之丢失 ——
   * 于是"选中一段文字再点加粗"会变成"什么都没加粗"。
   * 在 mousedown 阶段阻止默认行为就能保住选区。
   */
  const guard = (action: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    action();
  };

  const button = (label: string, active: boolean, action: () => void, title: string) => (
    <button
      type="button"
      title={title}
      onMouseDown={guard(action)}
      className={`${TOOL_BUTTON_CLASS} ${active ? TOOL_BUTTON_ACTIVE_CLASS : TOOL_BUTTON_IDLE_CLASS}`}
    >
      {label}
    </button>
  );

  const triggerClass = `${TOOL_BUTTON_CLASS} ${TOOL_BUTTON_IDLE_CLASS}`;

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-8 py-2">
      {button('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), '粗体')}
      {button('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), '斜体')}
      {button('U', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), '下划线')}
      {button('S', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), '删除线')}

      <span className={TOOL_DIVIDER_CLASS} />

      {([1, 2, 3] as const).map((level) =>
        button(
          `H${String(level)}`,
          editor.isActive('heading', { level }),
          () => editor.chain().focus().toggleHeading({ level }).run(),
          `${String(level)} 级标题`,
        ),
      )}

      <span className={TOOL_DIVIDER_CLASS} />

      {button('•', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), '无序列表')}
      {button('1.', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), '有序列表')}
      {button('"', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), '引用')}
      {button(
        '</>',
        editor.isActive('codeBlock'),
        () => editor.chain().focus().toggleCodeBlock().run(),
        '代码块(光标在块内时可选语言)',
      )}
      {button('⌀', editor.isActive('code'), () => editor.chain().focus().toggleCode().run(), '行内代码')}

      {/*
        语言下拉紧跟在代码块按钮后面 —— 它是"代码块的属性",
        放得离它近一点,用户一眼能连起来。
      */}
      {editor.isActive('codeBlock') && <CodeLanguageSelect editor={editor} />}

      <span className={TOOL_DIVIDER_CLASS} />

      <LinkPopover
        editor={editor}
        onClose={() => undefined}
        triggerClass={triggerClass}
        active={editor.isActive('link')}
      />

      <button
        type="button"
        title="插入图片"
        disabled={imageUploading}
        onMouseDown={guard(onPickImage)}
        className={`${TOOL_BUTTON_CLASS} ${TOOL_BUTTON_IDLE_CLASS} disabled:opacity-50`}
      >
        {imageUploading ? '上传中…' : '图片'}
      </button>

      <TableMenu editor={editor} triggerClass={triggerClass} />

      <span className={TOOL_DIVIDER_CLASS} />

      {button('↶', false, () => editor.chain().focus().undo().run(), '撤销')}
      {button('↷', false, () => editor.chain().focus().redo().run(), '重做')}
    </div>
  );
}
