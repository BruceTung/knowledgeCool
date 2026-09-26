import { IsString, Length } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';
import type { ChangePasswordInput } from '@knowledgecool/shared';

/**
 * 改密请求(首次强制改密与主动改密共用)。
 *
 * ⚠️ 这里**不校验新密码的强度** —— 那条规则在 `checkPasswordStrength`
 * (shared)里,由 service 调用。理由:D + T + O 各写一份正则迟早漂移,
 * 而"两处规则不一致"的表现是**某个入口能设出不合规的密码**,不会报错。
 *
 * `currentPassword` 必填,即便是首登强制改也必须提供:
 * 会话有可能被他人接管,多要一次密码能挡住一部分。
 */
export class ChangePasswordDto implements ChangePasswordInput {
  @IsString()
  @Length(1, 200, { message: '请输入当前密码' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, { message: '当前密码不正确' })
  currentPassword!: string;

  @IsString()
  @Length(1, 200, { message: '请输入新密码' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, {
    message: '密码过长:最多 72 字节(约 24 个汉字或 72 个 ASCII 字符)',
  })
  newPassword!: string;
}
