import { IsString, Length, Matches, MinLength } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';
import { EMPLOYEE_NO_PATTERN } from './login.dto.js';

/**
 * 首次初始化请求体(DESIGN.md §6.2:仅当库中无用户时可用)。
 *
 * ⚠️ v2.2 起工号是登录标识,不再是邮箱。
 *
 * 与 `LoginDto` 的区别:这里是**设定**密码,所以要施加强度要求。
 * 但只校验长度下限(8 位)—— "必须同时含字母与数字"那条由
 * `checkPasswordStrength` 在 service 里判定,保证规则**只有一处定义**,
 * 否则 DTO 的正则和 shared 的函数迟早会漂移。
 *
 * 密码长度用 **72 字节**上限而不是 `MaxLength(72)`:后者数的是字符,
 * 72 个汉字 = 216 字节,会被 bcrypt 静默截断。
 */
export class SetupDto {
  @IsString()
  @Matches(EMPLOYEE_NO_PATTERN, { message: '工号格式不正确:只允许字母、数字、点、下划线和短横线' })
  employeeNo!: string;

  @IsString()
  @Length(1, 64, { message: '姓名长度需在 1~64 个字符之间' })
  name!: string;

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, {
    message: '密码过长:最多 72 字节(约 24 个汉字或 72 个 ASCII 字符)',
  })
  password!: string;
}
