import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import {
  NODE_KINDS,
  NODE_STATUSES,
  type CreateNodeInput,
  type MoveNodeInput,
  type UpdateNodeInput,
} from '@knowledgecool/shared';

/** 标题长度上限。数据库是 text,这里限是为了界面与列表不被打爆。 */
const TITLE_MAX = 200;

export class CreateNodeDto implements CreateNodeInput {
  /**
   * 父节点。`null` = 建一级节点(部门)。
   *
   * 不传等价于 `null` —— 用类默认值而不是 `undefined`,是为了让
   * service 拿到的永远是 `string | null`,不必到处写 `?? null` 归一化。
   */
  @IsOptional()
  @IsUUID('4')
  parentId: string | null = null;

  @IsIn([...NODE_KINDS])
  kind!: CreateNodeInput['kind'];

  @IsOptional()
  @IsString()
  @MaxLength(TITLE_MAX)
  title?: string;
}

export class UpdateNodeDto implements UpdateNodeInput {
  @IsOptional()
  @IsString()
  @MaxLength(TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsIn([...NODE_STATUSES])
  status?: UpdateNodeInput['status'];

  /** 乐观锁。带错版本返回 409,由前端重新拉取。 */
  @IsInt()
  @Min(1)
  version!: number;
}

export class MoveNodeDto implements MoveNodeInput {
  /** `null` = 移到一级 */
  @IsOptional()
  @IsUUID('4')
  newParentId: string | null = null;

  /** 排到第几位(0 起);省略 = 排到最后 */
  @IsOptional()
  @IsInt()
  @Min(0)
  newPosition?: number;

  @IsInt()
  @Min(1)
  version!: number;
}
