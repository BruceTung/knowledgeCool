import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ProseMirrorDoc, SaveContentInput } from '@knowledgecool/shared';

/**
 * `PUT /pages/:id/content` 的请求体。
 *
 * `content` 用 `@IsObject()` 而不是 `@ValidateNested()`:文档树是**递归**结构,
 * 用 class-validator 描述它要么写一长串嵌套 DTO,要么放开 `forbidNonWhitelisted`。
 * 两者都不划算 —— 真正的结构校验在 `ContentService` 里用
 * `isProseMirrorDoc()` 做,那里能给出更准确的错误信息。
 *
 * ⚠️ 但**装饰器必须留着**:全局 ValidationPipe 开了 `whitelist`,
 * 没有装饰器的属性会被静默剥掉(踩过)。
 */
export class SaveContentDto implements SaveContentInput {
  @IsObject()
  content!: ProseMirrorDoc;

  /**
   * 乐观锁。客户端把读到的 `updatedAt` 原样带回;
   * 服务端发现库里更新更晚就返回 409,避免静默覆盖别人的编辑。
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baseUpdatedAt?: string;
}
