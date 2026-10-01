/**
 * 链接气泡(v2.10)。
 *
 * ## 为什么把 `window.prompt` 换掉
 *
 * 用户反馈「添加链接竟然是弹窗输入链接,这个不太对」。除了观感,`prompt` 有三个
 * 实际做不到的事:
 *   1. **只有一个输入框** —— 想同时定"地址"和"显示文字"必须分两次,而且改文字得先选中;
 *   2. **不能校验** —— 地址填错(比如 `javascript:`)拿不到任何提示,直接写进文档;
 *   3. **编辑已有链接时看不到原文** —— 只有个空输入框,用户不记得原来指的哪里。
 *
 * 换成一个贴着工具栏展开的气泡之后,这三件事都能做:
 * 两个字段、提交前归一化与校验、打开时回填当前值,并且带一个「移除链接」。
 *
 * ## 选区为什么会丢、怎么保住
 *
 * 触发按钮用 `onMouseDown` + `preventDefault()`(与工具栏其它按钮一致),所以打开时
 * 选区还在。用户点进输入框之后编辑器失焦,但 **ProseMirror 的选区存在自己的 state 里**,
 * 不会随 DOM 焦点消失 —— 提交时 `.focus()` 会把它恢复回来。
 * 这也是为什么这里**不能**用 `window.getSelection()` 去取选区。
 */
import type { Editor } from '@tiptap/core';
import { useState } from 'react';

import { Button, TextField } from '../../../components/ui';
import { normalizeUrl } from '../link-url';
import { POPOVER_CLASS, useDismiss } from './popover';

export function LinkPopover({
  editor,
  onClose,
  triggerClass,
  active,
}: {
  editor: Editor;
  onClose: () => void;
  /** 触发按钮的类名 —— 由工具栏决定(它有自己的规格常量)。 */
  triggerClass: string;
  /** 光标是否在链接上(用来决定按钮的高亮态)。 */
  active: boolean;
}) {
  const [open, setOpen] = useState(false);

  /** 打开那一刻的选区文本 —— 用来判断"显示文字被改过没有"。 */
  const [initialText, setInitialText] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hasExistingLink = editor.isActive('link');

  function openPopover(): void {
    const selection = editor.state.selection;
    const selected = selection.empty
      ? ''
      : editor.state.doc.textBetween(selection.from, selection.to, ' ');
    const currentHref = editor.getAttributes('link')['href'];

    // 回填**原始 href**(不剥协议)—— 剥掉再补会把用户写的 http:// 悄悄变成 https://
    setUrl(typeof currentHref === 'string' ? currentHref : '');
    setInitialText(selected);
    setText(selected);
    setError(null);
    setOpen(true);
  }

  function closePopover(): void {
    setOpen(false);
    onClose();
  }

  const ref = useDismiss(open, closePopover);

  function apply(): void {
    const normalized = normalizeUrl(url);
    if (!normalized.ok) {
      setError(normalized.reason);
      return;
    }

    const href = normalized.href;
    const trimmed = text.trim();
    const keepOriginalText = trimmed === '' || trimmed === initialText;
    const selection = editor.state.selection;

    let chain = editor.chain().focus();
    if (hasExistingLink) chain = chain.extendMarkRange('link');

    if (keepOriginalText && (hasExistingLink || !selection.empty)) {
      // 有现成的文字:只把链接挂上去(或改地址),不动文字
      chain.setLink({ href }).run();
    } else if (keepOriginalText) {
      // 空选区 + 没有现成链接:插入一段以地址为文字的链接
      chain
        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    } else {
      // 文字被改过:整段替换(没有选区时 deleteSelection 是空操作)
      chain
        .deleteSelection()
        .insertContent({ type: 'text', text: trimmed, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    }

    closePopover();
  }

  function remove(): void {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    closePopover();
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title="插入 / 编辑链接"
        aria-expanded={open}
        onMouseDown={(event) => {
          event.preventDefault();
          if (open) closePopover();
          else openPopover();
        }}
        className={`${triggerClass} ${active ? 'bg-slate-900 text-white' : ''}`}
      >
        链接
      </button>

      {open && (
        <form
          className={`${POPOVER_CLASS} left-0 w-80 space-y-2`}
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <TextField
            autoFocus
            label="链接地址"
            value={url}
            placeholder="example.com/a 或 /n/节点id"
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
          />

          <TextField
            label="显示文字"
            value={text}
            placeholder={initialText === '' ? '留空就用地址本身' : '留空则沿用原文'}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />

          {error !== null && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" variant="primary">
              应用
            </Button>
            {hasExistingLink && (
              <Button type="button" variant="secondary" onClick={remove}>
                移除链接
              </Button>
            )}
            <span className="flex-1" />
            <button
              type="button"
              className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
              onClick={closePopover}
            >
              取消
            </button>
          </div>

          <p className="text-xs leading-relaxed text-slate-500">
            只写域名会自动补 https://;站内路径(以 / 开头)与 #锚点 原样保留。
          </p>
        </form>
      )}
    </div>
  );
}
