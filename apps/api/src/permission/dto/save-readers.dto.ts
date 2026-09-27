import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

import { NODE_VISIBILITIES, type NodeVisibility, type SaveNodeReadersInput } from '@knowledgecool/shared';

/**
 * 保存可见性与读者名单(v2.12)。**整表替换**,与授权名单同一套约定。
 *
 * `userIds` 设了上限:名单是"给人看"的,几百人的名单在界面上已经不可用,
 * 而且它会让每次判定都多读一大批行。真要全公司可见,那应该用 public 而不是
 * 把所有人一个个加进来 —— 上限是替这种误用兜底。
 */
export class SaveReadersDto implements SaveNodeReadersInput {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsIn(NODE_VISIBILITIES)
  visibility?: NodeVisibility;

  @IsArray()
  @ArrayMaxSize(200, { message: '读者名单最多 200 人;要全公司可见请改用「公开」' })
  @IsUUID('all', { each: true })
  userIds!: string[];
}
