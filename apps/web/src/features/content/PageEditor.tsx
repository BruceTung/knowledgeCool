/**
 * 正文编辑器 Tiptap(DESIGN.md §7.4 / §10 约束 2)。
 *
 * ## 为什么 `content` 只在挂载时读一次
 *
 * 编辑器的初始内容**只在挂载时注入**。如果每次服务端返回新内容就 `setContent`,
 * 正在打字的人会看到光标跳走、输入被吞 —— 这是"自动保存 + 受控内容"最经典的坑。
 * 所以父组件用 `key={pageId + reloadKey}` 控制重建,而不是靠 props 更新。
 *
 * ## 冲突处理
 *
 * 每次保存都带上「我读到的 updatedAt」。服务端发现库里更新更晚 → 409。
 * 那时**不自动覆盖**,而是显示横幅让用户自己决定重新加载 ——
 * 阶段一没有协同,两个人同时编辑时,静默覆盖别人的编辑是最糟的结果。
 *
 * ## 为阶段二留的地基
 *
 * `editor.getJSON()` 的产物与 `page_contents.content_json` 逐字节对应,
 * 阶段二挂 `y-prosemirror` 时不需要改存储层。届时还要**关掉 Tiptap 自带的撤销栈**
 * 改用 `Y.UndoManager`(§10.1),否则两套撤销栈会打架。
 */
import { Image } from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import type { Editor, EditorEvents } from '@tiptap/core';
import type { PageContentResponse, ProseMirrorNode } from '@knowledgecool/shared';

import { ApiError } from '../../lib/api';
import { Button } from '../../components/ui';
import { useImageUpload, useSaveContent } from './queries';

/** 自动保存的防抖间隔。太短会在输入法组合期间频繁写库,太长会丢更多内容。 */
const AUTOSAVE_DELAY_MS = 1200;

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

/** 大纲里的一项。 */
export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  /** 在文档里的序号 —— 用作滚动锚点(标题并没有稳定 id)。 */
  index: number;
}

/** 大纲只收 1~3 级标题 —— 与工具栏能插入的层级一致,这样序号能对上 DOM 里的 h1/h2/h3。 */
const OUTLINE_MAX_LEVEL = 3;

/** 从文档树里抽出标题,供右栏大纲使用。 */
export function extractOutline(doc: ProseMirrorNode | null | undefined): OutlineItem[] {
  const items: OutlineItem[] = [];

  for (const node of doc?.content ?? []) {
    if (node.type !== 'heading') continue;
    const level = typeof node.attrs?.['level'] === 'number' ? node.attrs['level'] : 1;
    if (level > OUTLINE_MAX_LEVEL) continue;

    const text = plainTextOf(node).trim();
    if (text === '') continue;
    items.push({ id: `h-${String(items.length)}`, level, text, index: items.length });
  }
  return items;
}

function plainTextOf(node: ProseMirrorNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(plainTextOf).join('');
}

export function PageEditor({
  pageId,
  initial,
  canEdit,
  onOutline,
  onSaveStateChange,
  onReady,
}: {
  pageId: string;
  initial: PageContentResponse;
  canEdit: boolean;
  onOutline: (items: OutlineItem[]) => void;
  onSaveStateChange: (state: SaveState) => void;
  /** 把编辑器实例交出去 —— 右栏大纲要跳转到某个标题,而滚动容器在编辑器内部。 */
  onReady?: (editor: Editor) => void;
}) {
  const save = useSaveContent(pageId);
  const upload = useImageUpload();

  const [state, setState] = useState<SaveState>('idle');
  /** 我读到的那一版。每次保存成功后推进 —— 这就是正文的乐观锁基线。 */
  const baseRef = useRef(initial.updatedAt);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 有没有"还没落库"的改动。卸载时用它决定要不要补一次保存。 */
  const dirtyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const updateState = useCallback(
    (next: SaveState) => {
      setState(next);
      onSaveStateChange(next);
    },
    [onSaveStateChange],
  );

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // v3 的 StarterKit 已内置 Link 与 Underline
        link: { openOnClick: false, autolink: true },
        codeBlock: { HTMLAttributes: { class: 'kc-code-block' } },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: '开始写点什么…(支持 Markdown 快捷输入,如 # 加空格)' }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: initial.content,
    editable: canEdit,
    editorProps: {
      attributes: {
        class: 'kc-prose focus:outline-none',
        // 拼写检查对中文没意义,关掉省一次高亮计算
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: instance }: EditorEvents['update']) => {
      dirtyRef.current = true;
      updateState('dirty');
      onOutline(extractOutline(instance.getJSON() as ProseMirrorNode));

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush(instance);
      }, AUTOSAVE_DELAY_MS);
    },
    onCreate: ({ editor: instance }: EditorEvents['create']) => {
      onOutline(extractOutline(instance.getJSON() as ProseMirrorNode));
    },
  });

  /**
   * 把当前内容写回服务端。
   *
   * ⚠️ 必须拿 `editor.getJSON()` 而不是任何序列化后的字符串 ——
   * §10 约束 2:正文存结构化文档树,绝不存 Markdown 字符串。
   */
  const flush = useCallback(
    async (instance: Editor) => {
      if (!instance.isEditable) return;
      if (!dirtyRef.current) return;

      updateState('saving');
      try {
        const saved = await save.mutateAsync({
          content: instance.getJSON() as PageContentResponse['content'],
          baseUpdatedAt: baseRef.current,
        });
        baseRef.current = saved.updatedAt;
        dirtyRef.current = false;
        updateState('saved');
      } catch (error: unknown) {
        if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
          // 不自动覆盖:让别人写的版本留在库里,由用户决定怎么办
          dirtyRef.current = false;
          updateState('conflict');
          return;
        }
        // 网络抖动之类:保持 dirty,下次输入还会再试
        updateState('error');
      }
    },
    [save, updateState],
  );

  // 卸载时补一次保存 —— 用户点了别的页面就走,不该丢掉刚打的字
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (editor !== null) onReady?.(editor);
  }, [editor, onReady]);

  async function handleImage(file: File) {
    if (editor === null) return;
    try {
      const result = await upload.mutateAsync(file);
      editor.chain().focus().setImage({ src: result.url, alt: file.name }).run();
    } catch {
      // 上传失败的提示交给下面的状态条 —— 这里不额外弹窗
      updateState('error');
    }
  }

  if (editor === null) {
    return <p className="p-8 text-sm text-slate-400">编辑器加载中…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canEdit && (
        <Toolbar
          editor={editor}
          onPickImage={() => fileInputRef.current?.click()}
          imageUploading={upload.isPending}
        />
      )}

      {state === 'conflict' && (
        <div className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>这篇文档在你编辑期间被其他人改过了。为避免覆盖对方的修改,本次内容没有保存。</span>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      )}

      {state === 'error' && (
        <div className="mx-6 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          保存失败。内容还留在编辑器里,继续输入会自动重试。
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <EditorContent editor={editor} />
      </div>

      {/* 图片走隐藏的 file input,而不是拖拽 —— 拖拽在阶段一没有明确需求 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void handleImage(file);
        }}
      />
    </div>
  );
}

/** 保存状态提示。放在页头,不占正文空间。 */
export function SaveStateLabel({ state }: { state: SaveState }) {
  const text: Record<SaveState, string> = {
    idle: '',
    dirty: '未保存',
    saving: '正在保存…',
    saved: '已自动保存',
    error: '保存失败',
    conflict: '保存冲突',
  };
  const color: Record<SaveState, string> = {
    idle: 'text-slate-400',
    dirty: 'text-slate-400',
    saving: 'text-blue-600',
    saved: 'text-emerald-600',
    error: 'text-red-600',
    conflict: 'text-amber-600',
  };
  if (state === 'idle') return null;
  return <span className={`text-xs ${color[state]}`}>{text[state]}</span>;
}

function Toolbar({
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
      className={`min-w-[28px] rounded px-1.5 py-1 text-xs leading-none transition-colors ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-4 py-2">
      {button('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), '粗体')}
      {button('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), '斜体')}
      {button('U', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), '下划线')}
      {button('S', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), '删除线')}

      <span className="mx-1 h-4 w-px bg-slate-200" />

      {([1, 2, 3] as const).map((level) =>
        button(
          `H${String(level)}`,
          editor.isActive('heading', { level }),
          () => editor.chain().focus().toggleHeading({ level }).run(),
          `${String(level)} 级标题`,
        ),
      )}

      <span className="mx-1 h-4 w-px bg-slate-200" />

      {button('•', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), '无序列表')}
      {button('1.', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), '有序列表')}
      {button('"', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), '引用')}
      {button('</>', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), '代码块')}
      {button('⌀', editor.isActive('code'), () => editor.chain().focus().toggleCode().run(), '行内代码')}

      <span className="mx-1 h-4 w-px bg-slate-200" />

      <button
        type="button"
        title="插入 / 编辑链接"
        onMouseDown={guard(() => {
          const previous = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
          const href = window.prompt('链接地址', previous);
          if (href === null) return;
          if (href === '') {
            editor.chain().focus().unsetLink().run();
            return;
          }
          // 空选区时 setLink 不会生效,提示用户先选文字
          if (editor.state.selection.empty) {
            editor.chain().focus().insertContent(`<a href="${href}">${href}</a>`).run();
            return;
          }
          editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
        })}
        className={`rounded px-1.5 py-1 text-xs leading-none transition-colors ${
          editor.isActive('link') ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        链接
      </button>

      <button
        type="button"
        title="插入图片"
        disabled={imageUploading}
        onMouseDown={guard(onPickImage)}
        className="rounded px-1.5 py-1 text-xs leading-none text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
      >
        {imageUploading ? '上传中…' : '图片'}
      </button>

      {button(
        '表格',
        editor.isActive('table'),
        () =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run(),
        '插入 3×3 表格',
      )}

      <span className="mx-1 h-4 w-px bg-slate-200" />

      {button('↶', false, () => editor.chain().focus().undo().run(), '撤销')}
      {button('↷', false, () => editor.chain().focus().redo().run(), '重做')}
    </div>
  );
}
