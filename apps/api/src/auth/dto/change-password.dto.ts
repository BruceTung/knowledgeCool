import { IsString, Length } from 'class-validator';

import { MaxUtf8Bytes } from '../../common/validators/max-utf8-bytes.validator.js';
import { BCRYPT_MAX_PASSWORD_BYTES } from '../password.service.js';
import type { ChangePasswordInput } from '@knowledgecool/shared';

/**
 * **已登录用户**主动改密。
 *
 * ⚠️ 首次强制改密**不走这里** —— 它走 `InitialPasswordDto`(凭一次性凭证,
 * 不要当前密码)。两条路径分开是刻意的:它们的身份依据完全不同,
 * 混在一个 DTO 里会让"首登到底要不要当前密码"变成一个要靠 if 分支回答的问题。
 *
 * `currentPassword` 必填的理由是**会话可能被他人接管**(比如电脑没锁屏),
 * 多要一次密码能挡住一部分。
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
