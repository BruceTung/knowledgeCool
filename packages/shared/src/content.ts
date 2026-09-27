/**
 * 正文相关的共享类型 —— 对应 DESIGN.md §6.2 的正文接口与 §7.4 的文档模型。
 *
 * ⚠️ 这里的 `ProseMirrorDoc` 是 DESIGN.md §10 硬约束 2 的落地:
 * 正文**存结构化文档树,绝不存 Markdown 字符串**。
 * 阶段二挂 Yjs 时,`y-prosemirror` 的 XmlFragment 与这个结构是 1:1 映射的,
 * 存储层不需要动 —— 这就是现在把模型定对的价值。
 */

/** 行内标记(粗体、链接之类)。 */
export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * 文档树的一个节点。
 *
 * 刻意**不写成 Tiptap 的完整类型**:shared 包要同时给前后端用,
 * 引入 @tiptap/core 会让后端无端多一个依赖。这里只描述存储格式的结构约束,
 * 具体节点类型由编辑器决定(服务端对未知节点保持宽容,原样存取不报错)。
 */
export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  /** 叶子节点(如 text)才有 */
  text?: string;
  marks?: ProseMirrorMark[];
  /** 容器节点才有 */
  content?: ProseMirrorNode[];
}

/** 根节点必须是 `doc` —— 空文档也要有合法结构,否则前端 setContent 会抛错。 */
export interface ProseMirrorDoc extends ProseMirrorNode {
  type: 'doc';
  content?: ProseMirrorNode[];
}

/** 空文档常量。db 默认值、新建页面、正文被清空时都用它。 */
export const EMPTY_DOC: ProseMirrorDoc = Object.freeze({
  type: 'doc' as const,
  content: [],
});

/**
 * `GET /nodes/:id/content` 的响应体。
 *
 * v2.0 起由 `PageContentResponse` 改名 —— 空间与页面已合并为节点树(§4.1)。
 */
export interface NodeContentResponse {
  nodeId: string;
  content: ProseMirrorDoc;
  /** 正文最后保存时间。客户端下次保存时原样带回,用于冲突检测。 */
  updatedAt: string;
}

/**
 * `PUT /nodes/:id/content` 的请求体。
 *
 * `baseUpdatedAt` 是**可选的乐观锁**:客户端把「我读到的那一版」的时间戳带回来,
 * 服务端发现库里已经更新了就返回 409。
 *
 * 为什么正文不用 `nodes.version`:那个版本号被结构操作(改名/移动)共用,
 * 编辑正文会让改名冲突、改名会让正文冲突 —— 两者耦合是错的。
 * 阶段一没有协同,冲突检测只需要"不静默覆盖别人刚写的内容"这一个目标。
 */
export interface SaveContentInput {
  content: ProseMirrorDoc;
  /** 省略表示不做冲突检测(强制覆盖)。 */
  baseUpdatedAt?: string;
}

/** 导出格式。阶段一只做 Markdown —— PDF 需要额外依赖,不在 M6 范围内。 */
export const EXPORT_FORMATS = ['md'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * 一个节点(页面)最多能放几张图片。
 *
 * ⚠️ v2.12 之前**没有任何上限** —— 一个页面想插多少张就插多少张。
 * 用户的要求是"限制每个页面的最大文件上传数量,限制 10 个"。
 *
 * 放在 shared 而不是两端各写一个常量:服务端是**强制的闸**,前端用它做即时反馈,
 * 两边的数字必须是同一个 —— 否则会出现"前端拦了后端不拦"或者反过来的错位。
 *
 * 数的是**文档里的图片节点**,不是"上传过几次"。上传了但没插进文档的图片
 * 不计入,也不会被回收(见 DESIGN §11.3 的"孤儿附件"一条)。
 */
export const MAX_IMAGES_PER_NODE = 10;

/**
 * 数一棵文档树里的图片节点。
 *
 * 纯函数、零依赖,前后端共用 —— 这样这条规则就只有一个实现、一处可测。
 * 递归整棵树而不是只看顶层:图片可以嵌在表格单元格、引用块里面,
 * 只数顶层会漏掉它们,表现为"插到第 11 张才被拦、而且提示说只有 3 张"。
 */
export function countImages(doc: ProseMirrorNode | null | undefined): number {
  if (doc === null || doc === undefined) return 0;
  let count = doc.type === 'image' ? 1 : 0;
  for (const child of doc.content ?? []) count += countImages(child);
  return count;
}

/** 校验任意值是否是一个"够用"的 ProseMirror 文档。服务端入库前的最后一道闸。 */
export function isProseMirrorDoc(value: unknown): value is ProseMirrorDoc {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as { type?: unknown; content?: unknown };
  if (node.type !== 'doc') return false;
  if (node.content === undefined) return true;
  return Array.isArray(node.content);
}
