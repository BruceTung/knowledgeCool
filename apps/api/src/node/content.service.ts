/**
 * 正文服务(DESIGN.md §6.2 的正文接口 + §7.4 的文档模型)。
 *
 * v2.0 改名:`page` → `node`,表 `page_contents` → `node_contents`。
 * 三条硬约束的落地处**没变**:
 *
 * 1. **存结构化文档树,不存 Markdown 字符串**(§10 约束 2)。
 *    `content_json` 的类型就是 ProseMirror 的根节点,前端 `editor.getJSON()`
 *    直接落库,不经过任何序列化转换。阶段二挂 `y-prosemirror` 时不需要动存储层。
 * 2. **落库时同步拍纯文本**(§10 约束 6)。抽取逻辑在 `content/text-extract.ts`,
 *    是纯函数、有单测。这一列是检索的唯一数据源。
 * 3. **`ydoc_snapshot` 阶段一保持 null**。字段先建好,这就是"按协同的地基写代码"。
 *
 * ## 冲突检测的取舍
 *
 * 正文**不用** `nodes.version`(那个号被改名/移动共用,两者耦合会导致
 * "改正文让改名冲突"这种荒谬的行为)。改用 `baseUpdatedAt`:
 * 客户端把「我读到的那一版」的时间戳带回来,服务端发现更新更晚就返回 409。
 * 这是阶段一在没有协同的前提下,防止"两个人同时编辑、后写的静默吃掉前一个"的最小代价方案。
 */

import { Injectable } from '@nestjs/common';
import {
  EMPTY_DOC,
  MAX_IMAGES_PER_NODE,
  type Actor,
  type NodeContentResponse,
  type ProseMirrorDoc,
  type SaveContentInput,
  countImages,
  isProseMirrorDoc,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { runSerializable } from '../common/db/serializable.js';
import { AppError } from '../common/errors/app-error.js';
import { toMarkdown } from '../content/markdown.js';
import { extractPlainText } from '../content/text-extract.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permission/permission.service.js';

/**
 * 单篇正文的序列化上限。
 *
 * 不是数据库限制(Json 列能装很多),是**可运维性**限制:
 * 超大正文会让每次保存的往返变成好几 MB,而且说明有人把知识库当网盘用。
 * 2MB 已经能装下几十万字的文档。
 */
export const CONTENT_JSON_MAX_BYTES = 2 * 1024 * 1024;

/** 导出的结果。 */
export interface NodeExport {
  nodeId: string;
  title: string;
  markdown: string;
}

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * 取正文。
   *
   * ⚠️ **不鉴权** —— 读是所有登录用户开放的(§5.3 规则一)。
   * 但仍要确认节点**存在且未删除**,否则会返回一个"不存在的节点"的空正文,
   * 前端无法区分"这篇是空的"与"这篇不存在"。
   *
   * 节点刚建出来时 `node_contents` 里还没有行 —— 那**不是**错误,
   * 返回空文档即可。刻意不在读路径上 upsert:GET 不该产生写操作,
   * 否则一次爬虫式的遍历会给每个节点都插一行空内容。
   */
  async get(operator: Actor, nodeId: string): Promise<NodeContentResponse> {
    // v2.12:读也要过判定。受限节点对未授权的人是 404(不是 403)。
    const access = await this.permissions.requireRead(operator, nodeId);

    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { updatedAt: true },
    });
    if (node === null) throw AppError.notFound();
    void access;

    const row = await this.prisma.nodeContent.findUnique({
      where: { nodeId },
      select: { contentJson: true, updatedAt: true },
    });

    if (row === null) {
      return { nodeId, content: EMPTY_DOC, updatedAt: node.updatedAt.toISOString() };
    }

    return {
      nodeId,
      content: toDoc(row.contentJson),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 保存正文。
   *
   * 保存时同步重算 `text_for_search` —— 检索能搜到刚写的内容,靠的就是这一步。
   * 两步在同一个 upsert 里完成,不存在"正文存了但索引没更新"的窗口。
   */
  async save(
    operator: Actor,
    nodeId: string,
    input: SaveContentInput,
  ): Promise<NodeContentResponse> {
    await this.permissions.requireEdit(operator, nodeId);

    if (!isProseMirrorDoc(input.content)) {
      throw AppError.validation('正文格式不合法:根节点必须是 type=doc 的文档树');
    }

    // 每页图片上限。放在**服务端**才是真的闸 —— 前端那道只是即时反馈。
    // 数的是文档树里的 image 节点(递归),所以嵌在表格/引用块里的也算。
    const images = countImages(input.content);
    if (images > MAX_IMAGES_PER_NODE) {
      throw AppError.validation(
        `一个页面最多放 ${String(MAX_IMAGES_PER_NODE)} 张图片,当前有 ${String(images)} 张`,
      );
    }

    const bytes = Buffer.byteLength(JSON.stringify(input.content), 'utf8');
    if (bytes > CONTENT_JSON_MAX_BYTES) {
      throw AppError.validation(
        `正文过大(${String(Math.round(bytes / 1024))}KB),上限 ${String(CONTENT_JSON_MAX_BYTES / 1024 / 1024)}MB`,
      );
    }

    const textForSearch = extractPlainText(input.content);

    // ⚠️ 冲突检测与写入必须在**同一个 Serializable 事务**里。
    //
    // 原实现是"先查 updatedAt,再单独 upsert":两步之间没有任何保护,
    // 两个并发的保存可以各自通过检查、然后先后写入 —— 后写的那一次**静默吃掉**
    // 前一次。而这恰恰是整个 baseUpdatedAt 机制存在的目的(见文件头 §7.4 那段),
    // 换句话说:原来的写法让它要防的那件事照样能发生。
    const row = await runSerializable(this.prisma, async (tx) => {
      // 冲突检测:只在调用方给了 baseUpdatedAt 时才做。
      // 不给即"强制覆盖",用于导入、脚本修复这类场景。
      if (input.baseUpdatedAt !== undefined) {
        const current = await tx.nodeContent.findUnique({
          where: { nodeId },
          select: { updatedAt: true },
        });
        if (current !== null) {
          const base = Date.parse(input.baseUpdatedAt);
          // ⚠️ 解析不了**不能**当成"没有冲突"。那等于把一次格式错误静默降级成
          // 强制覆盖 —— 而客户端传这个字段的本意恰恰是"我基于这一版改的"。
          if (!Number.isFinite(base)) {
            throw AppError.validation('baseUpdatedAt 不是合法的时间');
          }
          if (current.updatedAt.getTime() > base) throw AppError.versionConflict();
        }
      }

      return tx.nodeContent.upsert({
        where: { nodeId },
        create: {
          nodeId,
          contentJson: input.content as unknown as Prisma.InputJsonValue,
          textForSearch,
        },
        update: {
          contentJson: input.content as unknown as Prisma.InputJsonValue,
          textForSearch,
        },
        select: { updatedAt: true },
      });
    });

    // 正文变动**不碰 nodes.version** —— 那个号被结构操作共用,
    // 推进它会让"改正文"引发"改名冲突"(§7.4)。
    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.content.update',
      targetType: 'node',
      targetId: nodeId,
      detail: { textLength: textForSearch.length, bytes },
    });

    return { nodeId, content: input.content, updatedAt: row.updatedAt.toISOString() };
  }

  /** 导出为 Markdown(M6)。标题作为一级标题写在最前面。 */
  async exportMarkdown(operator: Actor, nodeId: string): Promise<NodeExport> {
    // ⚠️ 导出是最容易漏的一条读取路径:少了它,受限文档可以整篇被下载走。
    await this.permissions.requireRead(operator, nodeId);

    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { title: true },
    });
    if (node === null) throw AppError.notFound();

    const row = await this.prisma.nodeContent.findUnique({
      where: { nodeId },
      select: { contentJson: true },
    });

    const doc = row === null ? EMPTY_DOC : toDoc(row.contentJson);
    const body = toMarkdown(doc);

    return {
      nodeId,
      title: node.title,
      markdown: `# ${node.title}\n\n${body}`.replace(/\n{3,}/g, '\n\n'),
    };
  }
}

/**
 * 把 JSONB 列读出来的值收敛成文档树。
 *
 * 数据库里可能存着历史结构(或被人手工改过),所以这里**不信任**它:
 * 不合法就退回空文档,而不是把脏数据透给编辑器 ——
 * Tiptap 拿到不合法的 JSON 会直接抛错,整个页面白屏。
 */
function toDoc(value: unknown): ProseMirrorDoc {
  return isProseMirrorDoc(value) ? value : EMPTY_DOC;
}
