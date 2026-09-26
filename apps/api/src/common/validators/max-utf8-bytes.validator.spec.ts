/**
 * 字节长度校验器测试。
 *
 * 这个校验器存在的唯一理由是 bcrypt 的 72 **字节**上限。
 * 因此测试必须钉住"汉字按 3 字节算"这件事 —— 否则会退回成
 * "看起来限制了、其实没限制住"的假校验。
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { MaxUtf8Bytes } from './max-utf8-bytes.validator.js';

class Probe {
  @MaxUtf8Bytes(72)
  value!: string;
}

async function errorsFor(value: unknown): Promise<number> {
  const instance = plainToInstance(Probe, { value });
  return (await validate(instance)).length;
}

describe('MaxUtf8Bytes', () => {
  it('72 个 ASCII 字符(72 字节)通过', async () => {
    await expect(errorsFor('a'.repeat(72))).resolves.toBe(0);
  });

  it('73 个 ASCII 字符(73 字节)不通过', async () => {
    await expect(errorsFor('a'.repeat(73))).resolves.toBe(1);
  });

  it('24 个汉字(72 字节)通过', async () => {
    await expect(errorsFor('汉'.repeat(24))).resolves.toBe(0);
  });

  it('25 个汉字(75 字节)不通过 —— 而 MaxLength(72) 会错误地放过它', async () => {
    const value = '汉'.repeat(25);
    expect(value.length).toBe(25); // 字符数远小于 72
    expect(Buffer.byteLength(value, 'utf8')).toBe(75);
    await expect(errorsFor(value)).resolves.toBe(1);
  });

  it('emoji 按 4 字节计算', async () => {
    await expect(errorsFor('🔐'.repeat(18))).resolves.toBe(0); // 72 字节
    await expect(errorsFor('🔐'.repeat(19))).resolves.toBe(1); // 76 字节
  });

  it('非字符串一律不通过', async () => {
    await expect(errorsFor(undefined)).resolves.toBe(1);
    await expect(errorsFor(123)).resolves.toBe(1);
    await expect(errorsFor(null)).resolves.toBe(1);
  });

  it('空字符串在字节维度是合法的(是否允许为空由 MinLength 管)', async () => {
    await expect(errorsFor('')).resolves.toBe(0);
  });
});
