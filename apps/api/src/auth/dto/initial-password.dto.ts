import { IsNotEmpty, IsString, Length } from 'class-validator';
import type { InitialPasswordInput } from '@knowledgecool/shared';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';

/**
 * 首次改密。
 *
 * ⚠️ **没有 `currentPassword`** —— 也不需要。
 *
 * 登录那一步已经用初始密码验证过身份了,再要一次是重复。
 * 代替它的是 `setupToken`:登录成功时签发的一次性凭证,
 * 10 分钟过期、只对签发它的那个用户有效、改过即作废。
 *
 * (这是用户明确要求的:「重置密码,不需要输入原密码,直接输入新密码」。)
 *
 * 强度规则与 `ChangePasswordDto` 保持一致 —— 这里只做长度与字节上限,
 * 真正的强度判定在 service 里调 `checkPasswordStrength`。
 * 两处各写一份正则迟早漂移,而漂移的表现是"某个入口能设出不合规的密码"。
 */
export class InitialPasswordDto implements InitialPasswordInput {
  @IsString()
  @IsNotEmpty({ message: '缺少改密凭证,请重新登录' })
  setupToken!: string;

  @IsString()
  @Length(1, 200, { message: '请输入新密码' })
  @MaxUtf8Bytes(BCRYPT_MAX_PASSWORD_BYTES, {
    message: '密码过长:最多 72 字节(约 24 个汉字或 72 个 ASCII 字符)',
  })
  newPassword!: string;
}
