import { PAGE_STATUSES, type PageStatus } from '@knowledgecool/shared';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * 新建页面(DESIGN.md §6.2 `POST /pages`)。
 *
 * `parentId` 显式允许 `null`(建在空间根下),所以不能用 `@IsOptional()`
 * 一挡了之 —— 那会把 null 也当成「没传」。用 `@ValidateIf` 只在非 null 时校验格式;
 * 于是它实际是**必填**(要么是合法 uuid,要么是明确的 null)。
 */
export class CreatePageDto {
  @IsUUID(undefined, { message: 'spaceId 必须是合法 uuid' })
  spaceId!: string;

  @ValidateIf((dto: CreatePageDto) => dto.parentId !== null)
  @IsUUID(undefined, { message: 'parentId 必须是合法 uuid' })
  parentId!: string | null;

  /** 省略时服务端用「未命名页面」(与数据库默认值一致)。 */
  @IsOptional()
  @IsString()
  @Length(1, 200, { message: '标题长度需在 1~200 个字符之间' })
  title?: string;
}

/**
 * 改名 / 改状态(DESIGN.md §6.2 `PATCH /pages/:id`)。
 *
 * `version` 必填 —— 结构操作走乐观锁(§4.1 第 6 条)。不匹配时返回 409,
 * 让客户端重新拉一次,而不是静默覆盖别人的修改。
 *
 * 注意:每个字段都**必须带校验装饰器**。全局 ValidationPipe 开了 whitelist,
 * 没有装饰器的属性会被直接剥掉 —— 表现是「传了但服务端说没传」。
 */
export class UpdatePageDto {
  @IsOptional()
  @IsString()
  @Length(1, 200, { message: '标题长度需在 1~200 个字符之间' })
  title?: string;

  @IsOptional()
  @IsIn([...PAGE_STATUSES], { message: '状态不合法' })
  status?: PageStatus;

  @IsInt({ message: 'version 必须是整数' })
  @Min(1, { message: 'version 不合法' })
  version!: number;
}

/**
 * 移动页面(DESIGN.md §6.2 `POST /pages/:id/move`)。
 *
 * 拖拽排序与改父级是同一个操作:目标父节点 + 目标位置一起给。
 */
export class MovePageDto {
  @ValidateIf((dto: MovePageDto) => dto.newParentId !== null)
  @IsUUID(undefined, { message: 'newParentId 必须是合法 uuid' })
  newParentId!: string | null;

  /** 0 起的插入下标。省略表示追加到末尾。 */
  @IsOptional()
  @IsInt({ message: 'newPosition 必须是整数' })
  @Min(0, { message: 'newPosition 不能为负' })
  newPosition?: number;

  @IsInt({ message: 'version 必须是整数' })
  @Min(1, { message: 'version 不合法' })
  version!: number;
}
