import { SPACE_ROLES, type SpaceRole } from '@knowledgecool/shared';
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../../auth/password.service.js';

/**
 * 邀请 / 创建成员(DESIGN.md §6.2 `POST /spaces/:id/members`)。
 *
 * 一个接口覆盖两种情形,因为管理员的意图都是「让这个人进空间」:
 *  - 邮箱已存在 → 直接用既有账号加入,`name` / `password` 会被忽略;
 *  - 邮箱不存在 → 必须同时给 `name` 与 `password`,服务端建号后加入。
 *
 * 密码上限用 **72 字节**而不是 MaxLength(72):后者数的是字符,
 * 72 个汉字 = 216 字节,会被 bcrypt 静默截断(同 SetupDto 的处理)。
 */
export class AddSpaceMemberDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(254)
  email!: string;

  @IsIn([...SPACE_ROLES], { message: '角色不合法' })
  role!: SpaceRole;

  /** 仅当邮箱未注册、需要建号时必填。 */
  @IsOptional()
  @IsString()
  @Length(1, 64, { message: '姓名长度需在 1~64 个字符之间' })
  name?: string;

  /** 仅当邮箱未注册、需要建号时必填。 */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, {
    message: '密码过长:最多 72 字节(约 24 个汉字或 72 个 ASCII 字符)',
  })
  password?: string;

  /**
   * 部门。阶段一的「用户组」就是它,所以这里必须能设置 ——
   * 否则「给某个部门授权」在界面上没有任何入口,组级规则形同虚设。
   */
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: '部门名最多 64 个字符' })
  department?: string;
}
