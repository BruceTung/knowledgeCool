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
import {
  USER_STATUSES,
  type SetUserAssignmentsInput,
  type UpdateUserInput,
} from '@knowledgecool/shared';

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

  /*
    ⚠️ v5.45(P0 修复)删掉了 `ownerId` 入参。

    原来它可以指定所有者,而 service 只用 `assertActiveUser` 校验
    「存在且在职」,**没有组织范围校验** —— 与 `setOwner` 是同一个洞
    (那两个都在 2026-10-04 被实测确认可越权任命)。

    为什么不补校验而**删掉入参**:
      · 建组本来就是「谁建谁负责」—— `NodeService.create` 一直是
        固定 `ownerId: operator.id`,两条建节点路径本来就不一致;
      · 真要指定负责人,界面上有独立的「权限 → 更换所有者」,
        那条路径修好之后是受校验的。让建组也开一个后门,
        等于同一件事有两个入口、只有一个有闸;
      · 前端从来没传过这个字段(`createOrgNode` 全仓库只有控制器
        一个调用方),删掉**不影响任何现有界面**。

    → 使命名所有权只有一条路,那条路上有范围校验、有审计。
  */
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

/**
 * 把某人加到某个节点下(v2.4)。
 *
 * ⚠️ 这里**只有 `userId`** —— 节点在路径参数里。因为这是**追加一条归属**,
 * 不是整表替换:目标节点是明确的,不需要一个数组。
 */
export class AddNodeMemberDto {
  @IsUUID('4', { message: '请选择一位在职成员' })
  userId!: string;
}
