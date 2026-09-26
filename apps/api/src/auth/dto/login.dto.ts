import { IsString, Length, Matches } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';

/**
 * 工号格式:1~64 个字母 / 数字 / `.` `_` `-`。
 *
 * 允许点与短横线是因为工号常写成 `KC-2026-001` 或 `kc.001` 这种形式;
 * 不允许空格与中文 —— 那多半是用户填错了(比如把姓名填进工号)。
 */
export const EMPLOYEE_NO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 登录请求体。
 *
 * ⚠️ **v2.2 起登录标识是工号,不是邮箱。**
 *
 * 这里**不校验密码强度** —— 登录校验的是「是否匹配」,不是「是否符合策略」。
 * 在此加 `MinLength` 会让"密码错"与"格式不对"返回不同错误,便于枚举账号。
 *
 * 但**上限必须保留**,而且与 `SetupDto` / `ChangePasswordDto` 用同一个 72 字节口径。
 * 原因是安全性的:bcrypt 只取前 72 字节,若不限制,"正确密码 + 任意后缀"也能登录成功。
 */
export class LoginDto {
  @IsString()
  @Matches(EMPLOYEE_NO_PATTERN, { message: '工号或密码不正确' })
  employeeNo!: string;

  @IsString()
  @Length(1, 200, { message: '密码不能为空' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, { message: '工号或密码不正确' })
  password!: string;
}
