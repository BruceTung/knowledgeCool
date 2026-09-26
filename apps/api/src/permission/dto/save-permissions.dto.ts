import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  PAGE_RULE_ROLES,
  PERMISSION_RULE_MAX_COUNT,
  PERMISSION_SUBJECT_MAX_LENGTH,
  SUBJECT_TYPES,
  type PageRuleRole,
  type SavePagePermissionsInput,
  type SubjectType,
} from '@knowledgecool/shared';

/**
 * 一条规则。
 *
 * ⚠️ 每个属性都**必须**有校验装饰器:全局 ValidationPipe 开了 `whitelist`,
 * 没有装饰器的属性会被静默剥掉 —— 表现为"提交了但字段没生效",不报错。
 * 这个坑在 M3 写页面 DTO 时踩过一次。
 */
export class PermissionRuleDto {
  @IsIn([...SUBJECT_TYPES])
  subjectType!: SubjectType;

  @IsString()
  @MinLength(1)
  @MaxLength(PERMISSION_SUBJECT_MAX_LENGTH)
  subjectId!: string;

  @IsIn([...PAGE_RULE_ROLES])
  role!: PageRuleRole;

  @IsBoolean()
  deny!: boolean;
}

/** `PUT /pages/:id/permissions` 的请求体:整表替换。 */
export class SavePermissionsDto implements SavePagePermissionsInput {
  @IsArray()
  @ArrayMaxSize(PERMISSION_RULE_MAX_COUNT)
  @ValidateNested({ each: true })
  @Type(() => PermissionRuleDto)
  rules!: PermissionRuleDto[];
}
