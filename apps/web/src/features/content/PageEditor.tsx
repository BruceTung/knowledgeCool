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
 * 改用 `Y.UndoManager`(§10 约束 7),否则两套撤销栈会打架。
 */
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import type { Editor, EditorEvents } from '@tiptap/core';
import {
  MAX_IMAGES_PER_NODE,
  countImages,
  type NodeContentResponse,
  type ProseMirrorNode,
} from '@knowledgecool/shared';

import { ApiError, sendBeaconJson } from '../../lib/api';
import { Button } from '../../components/ui';
import { useSaveContent } from '../org/queries';
import { DEFAULT_CODE_LANGUAGE, createLowlighter } from './code-languages';
import { TabKeymap } from './editor/tab-keymap';
import { EditorToolbar } from './editor/Toolbar';
import { useImageUpload } from './queries';

/**
 * 语法高亮器。**模块级单例** —— 它会注册十几个语言的语法(每个都是独立的
 * 解析函数),每次渲染都建一个既浪费内存也浪费时间。
 *
 * ⚠️ 这里用的是 `createLowlighter()` 而不是 `createLowlight()`:
 * 后者一个语言都没注册,`highlight()` 会对任何语言抛 `Unknown language`
 * (实测确认,不是推测)。注册表由 `CODE_LANGUAGES` 推导出来,并有单测钉住
 * "清单里的每个 id 都真的注册过"。
 */
const lowlight = createLowlighter();

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
  nodeId,
  initial,
  canEdit,
  onOutline,
  onSaveStateChange,
  onReady,
}: {
  nodeId: string;
  initial: NodeContentResponse;
  canEdit: boolean;
  onOutline: (items: OutlineItem[]) => void;
  onSaveStateChange: (state: SaveState) => void;
  /** 把编辑器实例交出去 —— 右栏大纲要跳转到某个标题,而滚动容器在编辑器内部。 */
  onReady?: (editor: Editor) => void;
}) {
  const save = useSaveContent(nodeId);
  const upload = useImageUpload();

  const [state, setState] = useState<SaveState>('idle');
  /** 当前页面的图片张数 —— 工具栏据此显示剩余额度并封顶。 */
  const [imageCount, setImageCount] = useState(0);
  /** 图片相关的提示(到达上限 / 上传失败)。与"保存状态"分开,两者的原因与后续动作都不一样。 */
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  /**
   * 最近一次保存失败的原因(v2.16)。
   *
   * 与 `state === 'error'` 分开:状态回答"现在什么情况",这条回答"为什么"。
   * 少了它,用户对"保存失败"唯一的线索是一句固定文案 —— 而这句文案
   * 对参数校验类错误(**再重试也不会成功**)是错的指引。
   */
  const [saveError, setSaveError] = useState<unknown>(null);
  /**
   * 只为了在**光标移动时**重渲染一次。
   *
   * ⚠️ 不这么做,工具栏的激活态会滞后:`isActive('bold')` / `isActive('table')` /
   * `isActive('codeBlock')` 都是"此刻光标在哪"的函数,而 `onUpdate` 只在**内容**
   * 变化时触发。表现是:点进代码块看不到语言下拉、光标移到加粗文字上 B 不亮 ——
   * 得再敲一个字才对。这类"看起来偶发"的问题基本都是少订阅了一个事件。
   */
  const [, bumpSelectionVersion] = useReducer((version: number) => version + 1, 0);
  /** 我读到的那一版。每次保存成功后推进 —— 这就是正文的乐观锁基线。 */
  const baseRef = useRef(initial.updatedAt);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 有没有"还没落库"的改动。卸载时用它决定要不要补一次保存。 */
  const dirtyRef = useRef(false);
  /**
   * 内容的最新快照。
   *
   * ⚠️ 卸载时**不能**再去问编辑器要 `getJSON()`:React 按声明顺序清理 effect,
   * `useEditor` 内部的销毁排在前面,等我们的清理函数跑到时编辑器已经不可靠了。
   * 所以每次输入时就把快照存下来,卸载时只读这个 ref。
   * 顺带省掉一次 `getJSON()` —— `onOutline` 本来就要算一次。
   */
  const snapshotRef = useRef<ProseMirrorNode | null>(null);
  /**
   * 卸载 / 离开页面时用的最新 `flush`。
   *
   * 卸载 effect 的依赖必须是空数组(只在卸载跑一次),所以不能直接把 `flush`
   * 写进去 —— 那样闭包会拿到第一次渲染时那一份,里面的 `save` 还是旧的 nodeId。
   * 用 ref 把最新的一份递过去。
   */
  const flushRef = useRef<((content: ProseMirrorNode) => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const updateState = useCallback(
    (next: SaveState) => {
      setState(next);
      onSaveStateChange(next);
    },
    [onSaveStateChange],
  );

  /**
   * 把当前内容写回服务端。
   *
   * ⚠️ 参数是**文档快照**而不是编辑器实例。原来传实例,于是在卸载时踩了坑:
   * `useEditor` 的销毁排在我们的清理函数之前,那一刻实例已经不可靠。
   * 现在快照在每次输入时就算好(反正 `onOutline` 本来也要算)。
   *
   * ⚠️ 必须存结构化文档树,不能存任何序列化后的字符串 ——
   * §10 约束 2:正文存结构化文档树,绝不存 Markdown 字符串。
   */
  const flush = useCallback(
    async (content: ProseMirrorNode) => {
      if (!canEdit) return;
      if (!dirtyRef.current) return;

      updateState('saving');
      try {
        const saved = await save.mutateAsync({
          content: content as NodeContentResponse['content'],
          baseUpdatedAt: baseRef.current,
        });
        baseRef.current = saved.updatedAt;
        dirtyRef.current = false;
        setSaveError(null);
        updateState('saved');
      } catch (error: unknown) {
        if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
          // 不自动覆盖:让别人写的版本留在库里,由用户决定怎么办
          dirtyRef.current = false;
          updateState('conflict');
          return;
        }
        /*
          ⚠️ v2.16:把失败**原因**留下来。

          原来这一行只有 `updateState('error')` —— `error` 这个变量从头到尾
          没被用过,原因被整个丢掉,界面只剩一句固定文案
          「保存失败。内容还留在编辑器里,继续输入会自动重试。」

          那句话对"网络抖动"成立,但对 **`VALIDATION_FAILED`(正文超 2MB、
          图片超过 10 张、`baseUpdatedAt` 解析不了)**完全不成立:
          再输入一百次也不会成功,而用户会一直以为它在重试。
          所以错误原因必须显示出来,并且由它决定文案。
        */
        setSaveError(error);
        updateState('error');
      }
    },
    [canEdit, save, updateState],
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // v3 的 StarterKit 已内置 Link 与 Underline
        link: { openOnClick: false, autolink: true },
        // ⚠️ 必须**关掉** StarterKit 自带的 codeBlock —— 它和下面的
        // `CodeBlockLowlight` 是同一个节点的两份实现,两个都注册会冲突
        // (表现是语言属性存不住、语法类名时有时无)。
        codeBlock: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        // 不选语言时用纯文本。设了默认值之后 `language` 属性**从创建那一刻就有值**,
        // 后面读属性不用到处判 undefined。
        defaultLanguage: DEFAULT_CODE_LANGUAGE,
        HTMLAttributes: { class: 'kc-code-block' },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: '开始写点什么…(支持 Markdown 快捷输入,如 # 加空格)' }),
      /*
        Tab 键(v2.17)。**必须放在表格扩展之后**不是硬要求(每个扩展各自拥有
        一个 keymap 插件,不是合并成一张表),但放在后面读起来更清楚:
        "表格先认领,其余的交给这个"。见 `tab-keymap.ts` 的说明。
      */
      TabKeymap,
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
      // 先把快照留下 —— 卸载或关页面时,这是唯一还能拿到内容的来源
      const doc = instance.getJSON() as ProseMirrorNode;
      snapshotRef.current = doc;
      dirtyRef.current = true;
      updateState('dirty');
      onOutline(extractOutline(doc));
      setImageCount(countImages(doc));

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flushRef.current?.(doc);
      }, AUTOSAVE_DELAY_MS);
    },
    onCreate: ({ editor: instance }: EditorEvents['create']) => {
      const doc = instance.getJSON() as ProseMirrorNode;
      onOutline(extractOutline(doc));
      setImageCount(countImages(doc));
    },
    onSelectionUpdate: () => {
      bumpSelectionVersion();
    },
  });

  /**
   * 卸载时补一次保存 —— 用户点了别的页面就走,不该丢掉刚打的字。
   *
   * ⚠️ 这里**必须真的写回服务端**。上一版只 `clearTimeout` 了待执行的自动保存
   * 就返回了,等于"把还没来得及写的那一次改动直接取消掉" —— 注释承诺的
   * 正是它没做的事。停笔 1.2 秒之内切页就是静默丢字(已实测复现:
   * 输入后 250ms 导航离开,零写入请求,服务端内容不变)。
   *
   * 依赖数组保持空:内部一律经 ref 取最新值,否则闭包会把旧的 nodeId 带回来。
   */
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const pending = snapshotRef.current;
      if (pending !== null && dirtyRef.current) {
        void flushRef.current?.(pending);
      }
    };
  }, []);

  /**
   * 关标签页 / 刷新时的兜底。
   *
   * 自动保存有 1.2 秒的防抖窗口,这段时间里关页面同样会丢字,而卸载清理
   * 在这个场景下不会跑(页面整个没了)。两条一起上:
   *
   *   1. `sendBeacon` 把快照交给浏览器投递 —— 页面卸载后它仍会继续发;
   *   2. **同时**按浏览器规矩弹一次确认。因为 beacon 是否真的送达,
   *      我们在页面里无法确认,而"多问一句"远比"静默丢字"便宜。
   *
   * 只对未保存的改动弹窗 —— 没有 dirty 就完全不打扰。
   */
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      if (!dirtyRef.current) return;
      const pending = snapshotRef.current;
      if (pending !== null) {
        sendBeaconJson(`/nodes/${nodeId}/content`, {
          content: pending,
          baseUpdatedAt: baseRef.current,
        });
      }
      event.preventDefault();
      // 老浏览器要求 returnValue 有值才弹;现代浏览器看 preventDefault。
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [nodeId]);

  useEffect(() => {
    if (editor !== null) onReady?.(editor);
  }, [editor, onReady]);

  async function handleImage(file: File) {
    if (editor === null) return;

    // 再数一次,**不依赖上面那个 state** —— 工具栏的按钮可能在 state 同步之前
    // 就被点到了,而这道闸失效的后果是"超出上限之后才被服务端拒绝"。
    if (countImages(editor.getJSON() as ProseMirrorNode) >= MAX_IMAGES_PER_NODE) {
      setImageNotice(
        `一个页面最多放 ${String(MAX_IMAGES_PER_NODE)} 张图片,已经放满了 —— 先删掉一张再插新的。`,
      );
      return;
    }
    setImageNotice(null);

    try {
      const result = await upload.mutateAsync(file);
      editor.chain().focus().setImage({ src: result.url, alt: file.name }).run();
    } catch (error: unknown) {
      // ⚠️ 上传失败**不能**复用下面那条"保存失败"状态。
      // 原来两者共用 state='error',而那条横幅写的是
      // "保存失败。内容还留在编辑器里,继续输入会自动重试。"
      // —— 对一次图片上传失败来说这句里没有一句成立:没有"保存",
      // 也没有任何"自动重试"。
      setImageNotice(
        error instanceof ApiError ? `图片上传失败:${error.message}` : '图片上传失败,请重试。',
      );
    }
  }

  if (editor === null) {
    return <p className="p-8 text-sm text-slate-500">编辑器加载中…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canEdit && (
        <EditorToolbar
          editor={editor}
          onPickImage={() => fileInputRef.current?.click()}
          imageUploading={upload.isPending}
          imageCount={imageCount}
        />
      )}

      {state === 'conflict' && (
        <div className="mx-8 mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>这篇文档在你编辑期间被其他人改过了。为避免覆盖对方的修改,本次内容没有保存。</span>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      )}

      {imageNotice !== null && (
        <div
          role="status"
          className="mx-8 mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <span>{imageNotice}</span>
          <Button variant="secondary" onClick={() => setImageNotice(null)}>
            知道了
          </Button>
        </div>
      )}

      {state === 'error' && (
        <div className="mx-8 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {/*
            文案分两种(见 flush 里那段说明):参数校验类错误**重试不会成功**,
            说"继续输入会自动重试"是误导。用 `ApiError.code` 区分 ——
            那是 §6.1 的稳定契约,不是去猜 message 的措辞。
          */}
          {saveError instanceof ApiError && saveError.code === 'VALIDATION_FAILED' ? (
            <>
              <b>这篇内容没能保存:</b>
              {saveError.message}
              <span className="mt-1 block">继续输入也不会成功,请先按提示修改(通常是正文过大或图片过多)。</span>
            </>
          ) : (
            <>
              <b>保存失败:</b>
              {saveError instanceof Error ? saveError.message : '原因未知'}
              <span className="mt-1 block">内容还留在编辑器里,继续输入会自动重试。</span>
            </>
          )}
        </div>
      )}

      {/* kc-print-area:打印时这个滚动容器要展开,否则只会印出第一屏(见 styles.css) */}
      <div className="kc-print-area min-h-0 flex-1 overflow-auto px-8 py-5">
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
    idle: 'text-slate-500',
    dirty: 'text-slate-500',
    saving: 'text-blue-600',
    saved: 'text-emerald-600',
    error: 'text-red-600',
    conflict: 'text-amber-600',
  };
  if (state === 'idle') return null;
  return <span className={`text-xs ${color[state]}`}>{text[state]}</span>;
}
