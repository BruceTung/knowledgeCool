import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import {
  COMMENT_BODY_MAX_LENGTH,
  type CreateCommentInput,
  type UpdateCommentInput,
} from '@knowledgecool/shared';

/**
 * 发表评论或回复。
 *
 * `parentId` 允许显式传 null(表示顶层评论)—— 所以不能只用 `@IsOptional()`,
 * 否则前端传 `{"parentId": null}` 会被 whitelist 剥掉。
 */
export class CreateCommentDto implements CreateCommentInput {
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

/**
 * 改评论正文 —— **只有一个字段**。
 *
 * 这里曾经还有 `status`(`open` / `resolved`),已经把评论当问题单用了。
 * 那套语义整体移除:评论就是评论(2026-09-27 用户明确纠正)。
 */
export class UpdateCommentDto implements UpdateCommentInput {
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body!: string;
}
