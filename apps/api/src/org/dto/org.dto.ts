import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { USER_STATUSES, type SetUserAssignmentsInput, type UpdateUserInput } from '@knowledgecool/shared';

import { EMPLOYEE_NO_PATTERN } from '../../auth/dto/login.dto.js';

/** 建部门 / 建组。两者的差别只在 `parentId` 是否为空。 */
export class CreateOrgNodeDto {
  @IsString()
  @Length(1, 64, { message: '名称长度需在 1~64 个字符之间' })
  name!: string;

  /**
   * `null`(或省略)= 建一级节点(部门),**仅超管可做**。
   *
   * 用类默认值而不是 `undefined`,让 service 拿到的永远是 `string | null`。
   */
  @IsOptional()
  @IsUUID('4')
  parentId: string | null = null;

  /** 指定所有者。省略时为操作者本人。 */
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;
}

/** 任命 / 变更所有者。 */
export class SetOwnerDto {
  @IsUUID('4', { message: '请选择一位在职成员' })
  ownerId!: string;
}

/** 建人(预置)。初始密码是内置常量,这里不接收密码。 */
export class CreateUserDto {
  @IsString()
  @Matches(EMPLOYEE_NO_PATTERN, {
    message: '工号格式不正确:只允许字母、数字、点、下划线和短横线',
  })
  employeeNo!: string;

  @IsString()
  @Length(1, 64, { message: '姓名长度需在 1~64 个字符之间' })
  name!: string;

  /** 可选:建号时一并指定归属节点。 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  nodeIds?: string[];
}

export class UpdateUserDto implements UpdateUserInput {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsIn([...USER_STATUSES])
  status?: UpdateUserInput['status'];
}

/** 整表替换某人的组织归属。 */
export class SetAssignmentsDto implements SetUserAssignmentsInput {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  nodeIds!: string[];
}
