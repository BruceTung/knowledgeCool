import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/bcrypt';

/**
 * bcrypt 的硬限制:它只取输入的前 **72 字节**,超出部分**静默丢弃**。
 *
 * 这一点必须显式防住,否则会产生两个真实的安全问题:
 *   1. 用户设了 30 个汉字的密码(90 字节),实际生效的只有前 24 个汉字 ——
 *      他以为的密码强度并不存在。
 *   2. 更糟:`密码` 与 `密码 + 任意后缀` 会被认为是同一个密码,都能登录。
 *
 * 所以做法是**在 DTO 层就用字节数拒绝**,而不是交给 bcrypt 截断。
 * 见 common/validators/max-utf8-bytes.validator.ts。
 */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

/**
 * 密码哈希 —— DESIGN.md §6.1.2 规定用 bcrypt(cost 12)。
 *
 * 用 `@node-rs/bcrypt`(Rust 实现)而不是 `bcrypt`:
 * 前者提供 `@node-rs/bcrypt-linux-x64-musl` 预编译包,而运行镜像是 node:22-alpine
 * (musl libc)。原生 `bcrypt` 走 node-gyp,在 alpine 上要么现场编译(需要 python/make/g++)
 * 要么直接失败 —— 这类问题只会在镜像构建时才炸,不值得冒。
 *
 * 产出标准 bcrypt 串(`$2b$<cost>$...`,60 字符),与其它语言实现的 bcrypt 互通。
 */
@Injectable()
export class PasswordService {
  /**
   * cost = 12。权衡:每 +1 计算量翻倍。12 在当代硬件上约 200~300ms,
   * 登录体感可接受,而暴力破解成本比 bcrypt 默认的 10 高 4 倍。
   */
  private static readonly SALT_ROUNDS = 12;

  hash(plainText: string): Promise<string> {
    return hash(plainText, PasswordService.SALT_ROUNDS);
  }

  verify(plainText: string, passwordHash: string): Promise<boolean> {
    return verify(plainText, passwordHash);
  }
}
