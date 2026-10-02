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
import { MAX_IMAGES_PER_NODE } from '@knowledgecool/shared';

import { CodeLanguageSelect } from './CodeLanguageSelect';
import { LinkPopover } from './LinkPopover';
import { pressHandlers } from './press-handlers';
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
  imageCount,
}: {
  editor: Editor;
  onPickImage: () => void;
  imageUploading: boolean;
  /** 当前页面已有的图片张数 —— 用来在到达上限时**禁用并说明原因**。 */
  imageCount: number;
}) {
  const imagesFull = imageCount >= MAX_IMAGES_PER_NODE;
  /*
    ⚠️ 原来这里只用 `onMouseDown` + `preventDefault()`:点按钮会先把焦点
    从编辑器抢走、选区随之丢失,于是"选中一段文字再点加粗"会变成"什么都没加粗"。
    那个理由成立,**但那套写法漏掉了键盘** —— 键盘激活 <button> 只派发 `click`
    ,`mousedown` 永远不发生。于是加粗、标题、列表、代码块、撤销/重做**全都
    键盘不可达**(WCAG 2.1.1 Level A)。

    `pressHandlers` 把两条路径都接上,并用 `detail === 0` 区分它们 ——
    鼠标点一次不会执行两遍。详细说明见 `editor/press-handlers.ts`。
  */
  /*
    ⚠️ v4.32:`aria-pressed` + `aria-label`。

    1. **切换态原来只靠颜色。** 加粗/斜体/标题/列表这些按钮的「按下」状态
       仅由 `TOOL_BUTTON_ACTIVE_CLASS`(深底白字)表达 —— **颜色是唯一线索**
       (WCAG 1.4.1「不能只用颜色传达信息」)。加了 `aria-pressed` 之后,
       读屏会念出「切换按钮,已按下」,不依赖颜色也能知道状态。

    2. **符号按钮没有可读名。** 可见文字是 `B` / `⌀` / `↶` / `</>` 这类符号,
       而可读名只写在 `title` 里 —— `title` **不能替代**无障碍名
       (它只在鼠标悬停时出现,且读屏支持很不一致)。
       现在把同一份文案同时给 `aria-label`,两处用同一个 `title` 变量,不会漂。

    ⚠️ **`aria-pressed` 只给真正的切换按钮。** 撤销/重做不是「开关」——
       它们是一次性动作,给它们 `aria-pressed="false"` 会让人以为
       「撤销」有个可以停留的按下态。所以 `toggling` 单独作参数,
       而不是靠 `active` 是否为 false 去猜(第 188 行那两个恰恰传的就是 false)。
  */
  const button = (
    label: string,
    active: boolean,
    action: () => void,
    title: string,
    toggling = true,
  ) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      {...(toggling ? { 'aria-pressed': active } : {})}
      {...pressHandlers(action)}
      className={`${TOOL_BUTTON_CLASS} ${active ? TOOL_BUTTON_ACTIVE_CLASS : TOOL_BUTTON_IDLE_CLASS}`}
    >
      {label}
    </button>
  );

  const triggerClass = `${TOOL_BUTTON_CLASS} ${TOOL_BUTTON_IDLE_CLASS}`;

  return (
    <div
      data-print="hide"
      className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-8 py-2"
    >
      {button(
        'B',
        editor.isActive('bold'),
        () => editor.chain().focus().toggleBold().run(),
        '粗体',
      )}
      {button(
        'I',
        editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(),
        '斜体',
      )}
      {button(
        'U',
        editor.isActive('underline'),
        () => editor.chain().focus().toggleUnderline().run(),
        '下划线',
      )}
      {button(
        'S',
        editor.isActive('strike'),
        () => editor.chain().focus().toggleStrike().run(),
        '删除线',
      )}

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

      {button(
        '•',
        editor.isActive('bulletList'),
        () => editor.chain().focus().toggleBulletList().run(),
        '无序列表',
      )}
      {button(
        '1.',
        editor.isActive('orderedList'),
        () => editor.chain().focus().toggleOrderedList().run(),
        '有序列表',
      )}
      {button(
        '"',
        editor.isActive('blockquote'),
        () => editor.chain().focus().toggleBlockquote().run(),
        '引用',
      )}
      {button(
        '</>',
        editor.isActive('codeBlock'),
        () => editor.chain().focus().toggleCodeBlock().run(),
        '代码块(光标在块内时可选语言)',
      )}
      {button(
        '⌀',
        editor.isActive('code'),
        () => editor.chain().focus().toggleCode().run(),
        '行内代码',
      )}

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

      {/*
        ⚠️ 到达上限时**先禁用**,而不是等他选完文件、等一次上传之后再拒绝。
        点了才被拒的体验更差 —— 那时用户已经付出了一次等待。
        剩余额度写在 title 里而不是按钮文字上:正文列只有 400 多 px,
        v2.8 已经因为按钮文字过长折过行。
      */}
      <button
        type="button"
        title={
          imagesFull
            ? `一个页面最多 ${String(MAX_IMAGES_PER_NODE)} 张图片,已经放满`
            : `插入图片(还能放 ${String(MAX_IMAGES_PER_NODE - imageCount)} 张)`
        }
        disabled={imageUploading || imagesFull}
        {...pressHandlers(onPickImage)}
        className={`${TOOL_BUTTON_CLASS} ${TOOL_BUTTON_IDLE_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {imageUploading ? '上传中…' : imagesFull ? '图片已满' : '图片'}
      </button>

      <TableMenu editor={editor} triggerClass={triggerClass} />

      <span className={TOOL_DIVIDER_CLASS} />

      {button('↶', false, () => editor.chain().focus().undo().run(), '撤销', false)}
      {button('↷', false, () => editor.chain().focus().redo().run(), '重做', false)}
    </div>
  );
}
