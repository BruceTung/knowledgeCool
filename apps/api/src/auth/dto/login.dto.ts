import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';

/**
 * 登录请求体。
 *
 * 这里**不校验密码强度** —— 登录校验的是「是否匹配」,不是「是否符合策略」。
 * 在此加 MinLength 会让「密码错」与「格式不对」返回不同错误,便于枚举。
 *
 * 但**上限必须保留**,而且与 SetupDto 用同一个 72 字节口径。原因是安全性的:
 * bcrypt 只取前 72 字节,若不限制,「正确密码 + 任意后缀」也能登录成功。
 * 只要两边的上限一致,就不存在"超出部分被忽略"的空间。
 */
export class LoginDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, 200, { message: '密码不能为空' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, { message: '邮箱或密码不正确' })
  password!: string;
}
