import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { COMMENT_BODY_MAX_LENGTH, COMMENT_STATUSES, type CommentStatus } from '@knowledgecool/shared';

/**
 * 发表评论或回复。
 *
 * `parentId` 允许显式传 null(表示顶层评论)—— 所以不能只用 `@IsOptional()`,
 * 否则前端传 `{"parentId": null}` 会被 whitelist 剥掉。
 */
export class CreateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

/** 改正文 / 切换解决状态。两者都省略时服务端会返回 400。 */
export class UpdateCommentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body?: string;

  @IsOptional()
  @IsIn([...COMMENT_STATUSES])
  status?: CommentStatus;
}
