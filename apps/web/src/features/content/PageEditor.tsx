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
 * ⚠️ 但**写入必须串行**(同一时刻只允许一次在飞)。并行发两次,第二次会带着尚未
 * 推进的 `baseUpdatedAt` 出去,被服务端判成 409 —— 那是**我们自己造出来的冲突**,
 * 而横幅会去怪一个并不存在的"其他人"。同时,"有没有未落库的改动"必须用
 * **编辑计数差**判断,不能用"上一次保存成不成功":后者会在保存期间把新输入的字
 * 静默丢掉。两件事的完整说明见 `flush` 与 `editSeqRef`。
 *
 * ## 为阶段二留的地基
 *
 * `editor.getJSON()` 的产物与 `node_contents.content_json` 逐字节对应,
 * 阶段二挂 `y-prosemirror` 时不需要改存储层。届时还要**关掉 Tiptap 自带的撤销栈**
 * 改用 `Y.UndoManager`(§10 约束 7),否则两套撤销栈会打架。
 */
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Editor, EditorEvents } from '@tiptap/core';
import {
  MAX_IMAGES_PER_NODE,
  countImages,
  type NodeContentResponse,
  type ProseMirrorNode,
} from '@knowledgecool/shared';

import { ApiError, sendBeaconJson } from '../../lib/api';
import { Button } from '../../components/ui';
import { registerPendingSave } from '../../lib/pending-save';
import { isSessionExpiredError } from '../../lib/session-expiry';
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
  const navigate = useNavigate();

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
  /**
   * 编辑计数:每次输入 +1。**它取代了原来那一个布尔 `dirtyRef`。**
   *
   * ⚠️ 那个布尔同时承担了两件事 ——「有没有未落库的改动」与「上一次保存成功了」——
   * 而在**保存进行中又来了新输入**时这两件事会分叉,后果是**静默丢字**:
   *
   *   1. 输入 → 防抖 1.2s → 发出保存 #1(慢网络下可能要好几秒才回来);
   *   2. 保存 #1 还没回来时用户又输入 → `dirtyRef = true`,又排一个定时器;
   *   3. 保存 #1 成功 → `dirtyRef = false` —— **把第 2 步那次改动也一起"清干净"了**,
   *      界面显示「已自动保存」;
   *   4. 第 2 步那个定时器到点 → `flush` 在 `if (!dirtyRef.current) return` 处
   *      直接返回,**一个字节都没写**;而状态还停在「已自动保存」;
   *   5. 用户离开 → 卸载补保存与 `beforeunload` 看的是同一个 `dirtyRef`,
   *      它仍是 false → **既不补写、也不弹确认**。全程无任何提示。
   *
   * 计数器把这两件事彻底拆开:`editSeq > savedSeq` 才叫"有未落库的改动",
   * 而"上一次保存成功"只推进 `savedSeq` —— 它永远追不上之后的编辑。
   */
  const editSeqRef = useRef(0);
  /** **已经成功落库**的那个编辑计数。 */
  const savedSeqRef = useRef(0);
  /**
   * 正在飞的那一次保存。
   *
   * ⚠️ 同一时刻只允许一次写入。并行写会用**同一个 `baseUpdatedAt`** 发两次,
   * 服务端按乐观锁把后一次判成 409 —— 于是横幅弹出"这篇文档在你编辑期间被其他人
   * 改过了",而实际上**这个冲突是我们自己造出来的**,根本没有第二个人。
   */
  const inFlightRef = useRef<Promise<void> | null>(null);
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
  const flushRef = useRef<((content: ProseMirrorNode, seq: number) => Promise<void>) | null>(null);
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
   * ⚠️ `seq` 是**产生这份快照的那次编辑**的计数,必须一路带着 ——
   * 只有它能让"这份内容落库了"与"之后又输入的内容还没落库"分开。
   * 少了它就会退回成"保存成功即认为全部干净"(旧实现的那个 bug)。
   *
   * ⚠️ 必须存结构化文档树,不能存任何序列化后的字符串 ——
   * §10 约束 2:正文存结构化文档树,绝不存 Markdown 字符串。
   */
  const flush = useCallback(
    async (content: ProseMirrorNode, seq: number) => {
      if (!canEdit) return;
      // 这一次要写的改动已经落库了(例如上一次 flush 顺手把它一起写了)
      if (seq <= savedSeqRef.current) return;

      /*
        ⚠️ 先等上一次写完再发。并行发两次会用**同一个 `baseUpdatedAt`**,
        服务端按乐观锁把后一次判成 409 —— 于是界面去怪"其他人改过了",
        而那是我们自己造的冲突。(这也是"编辑期间出现假冲突"的根因。)
      */
      const flying = inFlightRef.current;
      if (flying !== null) await flying;
      if (!canEdit || seq <= savedSeqRef.current) return;

      updateState('saving');

      const task = (async () => {
        try {
          const saved = await save.mutateAsync({
            content: content as NodeContentResponse['content'],
            baseUpdatedAt: baseRef.current,
          });
          baseRef.current = saved.updatedAt;
          /*
            ⚠️ 只把 `savedSeq` 推到**这一次真正写上去的那个计数**,而不是 `editSeq`。
            请求飞行期间用户可能又输入了 —— 那些字并没有进库,
            不能跟着一起被标成"已保存"。
          */
          savedSeqRef.current = Math.max(savedSeqRef.current, seq);
          setSaveError(null);
          // 落库之后又输入过 → 回到「未保存」,绝不显示「已自动保存」
          updateState(editSeqRef.current > savedSeqRef.current ? 'dirty' : 'saved');
        } catch (error: unknown) {
          if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
            /*
              不自动覆盖:让别人写的版本留在库里,由用户决定怎么办。

              ⚠️ 这里**刻意不推进 `savedSeq`**(旧实现是清掉那个"未保存"标记)。
              这些改动确实没进库,清了就等于宣布"干净了" —— 于是
              「重新加载」成了一次**没有任何确认的丢弃**,连刷新时浏览器那句
              确认也不会再弹(那个钩子看的就是这个标记)。
            */
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
      })();

      inFlightRef.current = task;
      try {
        await task;
      } finally {
        if (inFlightRef.current === task) inFlightRef.current = null;
      }
    },
    [canEdit, save, updateState],
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  /**
   * 把"这个编辑器还有没有没落库的字"登记到模块级表里,供**登出**等
   * 发生在别处的操作先冲刷。
   *
   * ⚠️ 登记的是**冲刷函数**,不是"脏标记":登出要的是"把它冲干净",
   * 而脏不脏只有编辑器自己最清楚(它按 `editSeq > savedSeq` 判)。
   * 这里把待保存快照与当时的计数一起交给 `flush`,与卸载补保存同一条路径 ——
   * 复用同一条,才不会出现"登出走的那条忘了带 seq"这类分叉。
   *
   * 返回值 `true` = 冲干净了。判据是**冲刷之后**计数追平(或本来就没有待写);
   * `false` 会让登出去弹一次确认(见 `AppLayout`)—— 宁可多问一句。
   */
  useEffect(() => {
    return registerPendingSave(async () => {
      const pending = snapshotRef.current;
      // 没有待写内容:本来就没有可丢的东西,算成功
      if (pending === null || editSeqRef.current <= savedSeqRef.current) return true;
      await flushRef.current?.(pending, editSeqRef.current);
      return editSeqRef.current <= savedSeqRef.current;
    });
  }, []);

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
      /*
        ⚠️ 计数与快照必须**同时**取,并把这一对一起交给 `flush`。
        分开取的话(flush 里现读 `editSeq`),请求飞行期间新输入的字会被
        误当成"已经写进去了"。
      */
      editSeqRef.current += 1;
      const seq = editSeqRef.current;
      updateState('dirty');
      onOutline(extractOutline(doc));
      setImageCount(countImages(doc));

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flushRef.current?.(doc, seq);
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
      // ⚠️ 判据是**计数差**,不是"上一次保存成不成功"。用后者的话,
      // "保存 #1 成功之后又输入的字"会被判成不需要补写 → 静默丢字。
      if (pending !== null && editSeqRef.current > savedSeqRef.current) {
        void flushRef.current?.(pending, editSeqRef.current);
      }
    };
  }, []);

  useEffect(() => {
    /*
      ⚠️⚠️ v4.21：**beacon 不能在这里发** —— 它必须等到「用户确实要离开」。

      `beforeunload` 只是**问一句**，用户完全可以点「留下」。而原来这段是
      「先发 beacon，再弹确认」：

        1. 用户打字 → 点关闭 → `beforeunload` 触发；
        2. **beacon 已经发出去了**（浏览器不会因为用户后来选择留下而撤回它）；
        3. 用户点「留下」—— 页面留着，但那条内容**已经落库**；
        4. 而本地 `baseRef` / `savedSeqRef` **一个都没推进**（我们以为没保存成功）；
        5. 下一次自动保存仍带着**旧的** `baseUpdatedAt` →
           服务端 `content.service.ts:176` 判 `current.updatedAt > base` → **409**。

      后果不是「多一次报错」那么轻：编辑器进入 `conflict` 态，
      而 `conflict` 唯一的出路是「重新加载」（`window.location.reload`），
      于是用户**丢掉手上没保存的字**，还被告诉「别人改过这篇文档」——
      而那个人其实是他自己那条 beacon。

      所以顺序反过来：**先让浏览器弹确认，只有在「确实要走了」的那一刻才发 beacon。**
      问题是 `beforeunload` **不告诉我们用户选了哪个** —— 标准里没有这个回调。

      做法：**把 beacon 推迟到 `pagehide` / `unload`** —— 那两个事件只在页面
      真的被卸载时才触发，用户点「留下」时不会发生。`sendBeacon` 本就为这个
      时机设计（它由浏览器接管投递，页面没了也会发出去）。
    */
    function flushBeacon(): void {
      // ⚠️ 判据是**计数差**。用旧的那个布尔时，「保存 #1 成功之后又输入的字」
      // 会被判成「干净」—— 关页面既不补发 beacon、也不弹确认，直接丢。
      if (editSeqRef.current <= savedSeqRef.current) return;
      const pending = snapshotRef.current;
      if (pending === null) return;
      sendBeaconJson(`/nodes/${nodeId}/content`, {
        content: pending,
        baseUpdatedAt: baseRef.current,
      });
    }

    // 只负责「问一句」，**不发** beacon。
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      if (editSeqRef.current <= savedSeqRef.current) return;
      event.preventDefault();
      // 老浏览器要求 returnValue 有值才弹；现代浏览器看 preventDefault。
      event.returnValue = '';
    }

    /*
      这两个才是「真的走了」。`pagehide` 覆盖 bfcache 与移动端
      （某些浏览器在 `unload` 上不可靠）；`unload` 兜住其余情形。
      两个都挂上，用一个标志防止重复投递 —— `savedSeq` 在这里并不会推进
      （beacon 的响应我们收不到），所以没有这个标志就会发两次。
    */
    let beaconSent = false;
    function onPageHide(): void {
      if (beaconSent) return;
      beaconSent = true;
      flushBeacon();
    }

    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('unload', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('unload', onPageHide);
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
          <span>
            这篇文档在你编辑期间被其他人改过了。为避免覆盖对方的修改,本次内容没有保存;
            <b>你未保存的改动目前只在这个页面里</b>。
          </span>
          {/*
            ⚠️ 这个按钮会**丢掉本地未保存的内容**,所以文案必须写明后果。
            浏览器那句"确定要离开吗"靠的是 `beforeunload`,而它只在
            `editSeq > savedSeq` 时才弹 —— 冲突之后**刻意不再清那个标记**,
            所以这条路会真的问一次(旧实现把标记清掉了,于是刷新是静默丢弃)。
          */}
          <Button variant="secondary" onClick={() => window.location.reload()}>
            放弃我的改动并重新加载
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
        /*
          ⚠️ v4.9:这里现在分**三种**,而不是两种。

          「保存失败」原来只剩一个兜底分支,文案是「内容还留在编辑器里,
          继续输入会自动重试」。那句话对网络抖动是对的 —— 但对**会话过期**
          是灾难性的:重试永远不会成功(每次都还是 401),而用户按这句话
          一直输入、一直等,直到关掉页面才发现字全丢了。

          而且它**看不出区别**:用户没有任何线索去怀疑"其实是我掉线了"。
          现在按 `ApiError.code` 分成三类 —— 那是 §6.1 的稳定契约,
          不是去猜 message 的措辞:
            · `UNAUTHORIZED`     → 会话过期:重试不会成功,要重新登录;
            · `VALIDATION_FAILED` → 内容本身不合法:改内容才有用;
            · 其余(网络等)     → 自动重试**确实**有意义。
        */
        <div
          role="alert"
          className="mx-8 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {isSessionExpiredError(saveError) ? (
            <>
              <b>保存失败:登录状态已过期。</b>
              <span className="mt-1 block">
                这张页面上的改动还在,但**不会再自动重试**了 —— 请重新登录后回来继续编辑。
              </span>
              <span className="mt-2 block">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigate('/login');
                  }}
                >
                  去重新登录
                </Button>
              </span>
            </>
          ) : saveError instanceof ApiError && saveError.code === 'VALIDATION_FAILED' ? (
            <>
              <b>这篇内容没能保存:</b>
              {saveError.message}
              <span className="mt-1 block">
                继续输入也不会成功,请先按提示修改(通常是正文过大或图片过多)。
              </span>
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
        aria-label="选择要插入的图片"
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
