import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';

/**
 * 首次初始化请求体(DESIGN.md §6.2:仅当库中无用户时可用)。
 *
 * 与 LoginDto 的区别:这里是**设定**密码,所以要施加强度要求。
 *
 * 密码长度用 **72 字节**上限,而不是 MaxLength(72):后者数的是字符,
 * 72 个汉字 = 216 字节,会被 bcrypt 静默截断(见 PasswordService 注释)。
 * 24 个汉字或 72 个 ASCII 字符,是这个上限的直观口径。
 */
export class SetupDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(254)
  email!: string;

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
