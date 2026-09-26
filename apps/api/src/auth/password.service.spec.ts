/**
 * 密码哈希测试 —— 这里用**真实** bcrypt,不打桩。
 * 打桩就测不出「哈希串能不能被 verify」这种真正要保证的事。
 */
import { describe, expect, it } from 'vitest';

import { BCRYPT_MAX_PASSWORD_BYTES, PasswordService } from './password.service.js';

const service = new PasswordService();

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

describe('PasswordService', () => {
  it('哈希结果不是明文,且是标准 bcrypt 串', async () => {
    const digest = await service.hash('correct horse battery staple');

    expect(digest).not.toContain('correct horse');
    expect(digest).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(digest).toHaveLength(60);
    expect(digest.startsWith('$2b$12$')).toBe(true);
  });

  it('同一明文两次哈希结果不同(加盐生效)', async () => {
    const [a, b] = await Promise.all([service.hash('same-password'), service.hash('same-password')]);
    expect(a).not.toBe(b);
  });

  it('正确密码校验通过', async () => {
    const digest = await service.hash('s3cret-passphrase');
    await expect(service.verify('s3cret-passphrase', digest)).resolves.toBe(true);
  });

  it('错误密码校验失败', async () => {
    const digest = await service.hash('s3cret-passphrase');
    await expect(service.verify('s3cret-passphras', digest)).resolves.toBe(false);
    await expect(service.verify('', digest)).resolves.toBe(false);
    await expect(service.verify('S3CRET-PASSPHRASE', digest)).resolves.toBe(false);
  });

  it('中文密码也能正确往返', async () => {
    const password = '知识库密码测试'; // 21 字节,在 72 字节上限内
    expect(bytes(password)).toBeLessThanOrEqual(BCRYPT_MAX_PASSWORD_BYTES);

    const digest = await service.hash(password);
    await expect(service.verify(password, digest)).resolves.toBe(true);
    await expect(service.verify('知识库密码测定', digest)).resolves.toBe(false);
  });

  it('恰好 72 字节的密码可用', async () => {
    const password = 'a'.repeat(BCRYPT_MAX_PASSWORD_BYTES);
    const digest = await service.hash(password);
    await expect(service.verify(password, digest)).resolves.toBe(true);
  });

  /**
   * 这条测试**记录的是 bcrypt 的缺陷行为**,不是我们希望的行为。
   *
   * 它存在的意义:证明「为什么必须在 DTO 层用字节数限制密码长度」。
   * 如果哪天有人把 DTO 里的 MaxUtf8Bytes 去掉,这条测试仍然会通过,
   * 但下面这段注释就是证据 —— 超过 72 字节的部分会被静默忽略,
   * 于是「正确密码 + 任意后缀」也能登录。
   */
  it('bcrypt 在 72 字节处静默截断(故 DTO 层必须用字节数设上限)', async () => {
    const exact = 'a'.repeat(BCRYPT_MAX_PASSWORD_BYTES);
    const digest = await service.hash(exact);

    // 前缀相同、超出 72 字节的部分不同 —— bcrypt 认为它们是同一个密码
    await expect(service.verify(`${exact}DIFFERENT-SUFFIX`, digest)).resolves.toBe(true);
  });
});
