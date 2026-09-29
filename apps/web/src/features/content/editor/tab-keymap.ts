/**
 * Tab 键在正文里的行为(DESIGN.md §7.4)。
 *
 * ## 为什么需要它
 *
 * ⚠️ **默认情况下按 Tab 会把焦点移出编辑器**,跳到页面上下一个可聚焦的元素
 * (工具栏按钮、右栏目录项……)。这不是"某个扩展没配好",而是
 * **ProseMirror 的默认行为**:它不接管 Tab,浏览器就按无障碍规范把焦点移走。
 *
 * 全仓库唯一接管 Tab 的是表格扩展(`@tiptap/extension-table`),而它的写法是:
 *
 *     Tab: () => {
 *       if (this.editor.commands.goToNextCell()) return true;
 *       if (!this.editor.can().addRowAfter()) return false;   // ← 不在表格里
 *       return this.editor.chain().addRowAfter().goToNextCell().run();
 *     }
 *
 * 也就是说**不在表格里时它明确返回 false**,把按键还给浏览器 —— 于是焦点移走。
 * 用户在正文里按 Tab 想缩进,光标却跑到工具栏上,输入当场中断。
 *
 * ## 四条规则(与主流编辑器的约定一致)
 *
 * | 光标在哪 | Tab | Shift+Tab |
 * |---|---|---|
 * | 只读页面 | **不接管**(让焦点照常走) | 同左 |
 * | 表格 | **让路给表格扩展**(移到下一格 / 末格补一行) | 移到上一格 |
 * | 列表项 | 降一级(嵌套到上一个兄弟下面) | 升一级 |
 * | 代码块 | 插入制表符 | 删掉行首一个缩进 |
 * | 普通段落 / 标题 | 插入制表符 | 什么都不做,但**吞掉按键** |
 *
 * ⚠️ **为什么列表里是"缩进"而不是"插入制表符":** 往列表项的**文字里**塞一个
 * 制表符没有任何意义(它看起来什么都不像),而"Tab 把当前项降一级"是所有编辑器
 * (Word / Google Docs / Confluence / Notion)的统一约定。列表里降不了级时
 * (已经是本层第一个)保持原位,但**仍然吞掉按键** —— 让焦点莫名其妙跳走
 * 比"没反应"更糟。
 *
 * ⚠️ **只读页面不接管 Tab。** 那时正文不可编辑,插入任何东西都没有意义,
 * 而用户的意图正是"在页面里走"(键盘无障碍就靠它)。所以 read-only 时
 * 直接返回 false,把手势还给浏览器。
 *
 * ⚠️ **表格那一条必须"显式让路"。** Tiptap **不会**把所有扩展的快捷键并成一张表
 * —— 每个扩展各自拥有一个 keymap 插件(见 `ExtensionManager` 里逐个
 * `keymap(defaultBindings)` 的写法)。所以"我的处理器返回 false"会自然落到
 * 表格的处理器上,无论扩展在数组里的先后如何。反过来若在这里自己实现
 * 一次 `goToNextCell`,就等于把表格的移动逻辑抄成第二份(§12:写数据的逻辑
 * 只允许存在一份 —— 读/移动逻辑同理)。
 */
import { Extension, type Editor } from '@tiptap/core';

/**
 * 一个制表符等于几个字符宽。
 *
 * ⚠️ 必须与 `styles.css` 里 `.kc-prose { tab-size: 4 }` 的**数字相同**:
 * 前者决定 Shift+Tab 一次退几格,后者决定它在屏幕上占多宽。
 * 两处不一致的表现是"退一格退不干净"(视觉上还剩下半个制表符)。
 */
export const TAB_SIZE = 4;

/** 在光标处插入一个字面制表符。 */
function insertTab(editor: Editor): boolean {
  const { state, view } = editor;
  const { from, to } = state.selection;
  /*
    ⚠️ 用 `tr.insertText` 而不是 `editor.commands.insertContent('\t')`:
    `insertContent` 收到字符串时会**先按 HTML 解析**,而制表符在 HTML 里
    属于可折叠空白 —— 会被解析器吃掉或压成一个空格。表现是"按了没反应",
    而代码看起来完全正确。
    `tr.insertText` 直接把文本节点放进文档,不经过 HTML 解析。
  */
  view.dispatch(state.tr.insertText('\t', from, to));
  return true;
}

/**
 * 代码块里退一格:删掉行首的**一个制表符**,或最多 `TAB_SIZE` 个空格。
 *
 * 两种都要认:Tab 插进来的是制表符,而从别处粘贴来的代码行首往往是空格。
 * 只认其中一种的话,另一种按 Shift+Tab 会毫无反应,看起来像坏了。
 */
function outdentCodeLine(editor: Editor): boolean {
  const { state, view } = editor;
  const { $from } = state.selection;

  /*
    ⚠️ 必须先确认光标真的**在代码块里**。

    若选区是整个块的 NodeSelection(例如用户从块外拖选),`$from.parent`
    是 doc 而不是 codeBlock —— 那时 `$from.start()` 会算出文档级的位置,
    下面的 delete 就会**删掉正文里别处的字符**。这个分支只是吞掉按键,
    宁可"没反应"也不能删错东西。
  */
  if ($from.parent.type.name !== 'codeBlock') return true;

  const blockStart = $from.start();
  const blockEnd = $from.end();
  const beforeCursor = state.doc.textBetween(blockStart, $from.pos);
  // 光标所在行的行首
  const lineStart = blockStart + (beforeCursor.lastIndexOf('\n') + 1);

  /*
    ⚠️ 缩进要看**整行**,不能只看光标左边那一段。

    第一版取的是 `textBetween(lineStart, $from.pos)`(光标左边的部分),
    于是**光标停在行首时它永远是空串** —— 判定成"没有缩进",Shift+Tab
    什么都不做。而"点一下代码块"恰好就把光标放在行首(块的左内边距那一片
    点下去落在行首),所以这个 bug 在真机上一按就能复现。

    编辑器的通行做法是"退掉这一行的行首缩进",与光标停在第几列无关 ——
    VS Code / 各 IDE 都是这样。所以这里取到行尾。
  */
  const restOfBlock = state.doc.textBetween(lineStart, blockEnd);
  const lineEnd = restOfBlock.indexOf('\n');
  const lineText = lineEnd < 0 ? restOfBlock : restOfBlock.slice(0, lineEnd);

  let width = 0;
  if (lineText.startsWith('\t')) {
    width = 1;
  } else {
    const spaces = /^ +/.exec(lineText);
    if (spaces !== null) width = Math.min(spaces[0].length, TAB_SIZE);
  }
  // 行首本来就没有缩进:不删任何东西(但仍然吞掉按键)
  if (width === 0) return true;

  view.dispatch(state.tr.delete(lineStart, lineStart + width));
  return true;
}

export const TabKeymap = Extension.create({
  name: 'kcTabKeymap',

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const editor = this.editor;

        // 只读页面:不接管,让焦点照常走(见文件头)
        if (!editor.isEditable) return false;

        // 表格:让路给 @tiptap/extension-table(见文件头最后一条 ⚠️)
        if (editor.isActive('table')) return false;

        if (editor.isActive('listItem')) {
          editor.chain().focus().sinkListItem('listItem').run();
          // 无论降级成功与否都吞掉按键 —— 见文件头关于列表的那一条
          return true;
        }

        return insertTab(editor);
      },

      'Shift-Tab': () => {
        const editor = this.editor;

        if (!editor.isEditable) return false;
        if (editor.isActive('table')) return false;

        if (editor.isActive('listItem')) {
          editor.chain().focus().liftListItem('listItem').run();
          return true;
        }

        if (editor.isActive('codeBlock')) return outdentCodeLine(editor);

        // 普通段落没有"退一级"这回事,但按键仍然要吞掉,否则焦点会跳走
        return true;
      },
    };
  },
});
