import { IsObject, IsOptional, IsString } from 'class-validator';
import type { ProseMirrorDoc, SaveContentInput } from '@knowledgecool/shared';

/**
 * 保存正文的请求体。
 *
 * `content` 这里**只做"是不是对象"的形状校验** —— 真正的内容校验在
 * `ContentService.save` 里用 `isProseMirrorDoc` 做(它需要判断文档树的结构)。
 *
 * 为什么不在这里写树形校验:用 class-validator 表达一棵递归的文档树既啰嗦,
 * 又必然和前端 Tiptap 的实现漂移;而那段逻辑本来就已经是共享的纯函数,
 * 单测也覆盖了。
 */
export class SaveContentDto implements SaveContentInput {
  @IsObject()
  content!: ProseMirrorDoc;

  /**
   * 乐观锁:客户端把「我读到的那一版」的时间戳带回来。
   * 省略表示**强制覆盖**(导入、脚本修复这类场景需要它)。
   */
  @IsOptional()
  @IsString()
  baseUpdatedAt?: string;
}
