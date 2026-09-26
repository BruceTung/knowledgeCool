/**
 * 首登改密凭证的单测。
 *
 * ⚠️ 这个模块是**整条"首次改密"链路的唯一身份依据** ——
 * 它错了的后果是「任何人都能改别人的密码」。所以每一个拒绝分支都必须有断言,
 * 尤其是"改了 payload 但签名没跟着变"那一条。
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SETUP_TOKEN_TTL_MS, signSetupToken, verifySetupToken } from './setup-token.js';

const SECRET = 'test-secret';

/** 自己造一个签名正确的畸形 payload —— 用来测"签名过了但内容不合法"。 */
function forge(payload: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function signRaw(raw: string, secret: string): string {
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

describe('setup-token 签发与校验', () => {
  it('同一个密钥能验回用户 id', () => {
    const { token } = signSetupToken('u-1', SECRET);
    expect(verifySetupToken(token, SECRET)).toBe('u-1');
  });

  it('有效期 10 分钟', () => {
    const now = Date.UTC(2026, 8, 27, 0, 0, 0);
    const { expiresAt } = signSetupToken('u-1', SECRET, now);
    expect(expiresAt.getTime() - now).toBe(SETUP_TOKEN_TTL_MS);
    expect(SETUP_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('刚好到点算过期(边界取闭区间)', () => {
    const now = Date.UTC(2026, 8, 27, 0, 0, 0);
    const { token } = signSetupToken('u-1', SECRET, now);

    expect(verifySetupToken(token, SECRET, now + SETUP_TOKEN_TTL_MS - 1)).toBe('u-1');
    expect(verifySetupToken(token, SECRET, now + SETUP_TOKEN_TTL_MS)).toBeNull();
    expect(verifySetupToken(token, SECRET, now + SETUP_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('换一个密钥 → null', () => {
    const { token } = signSetupToken('u-1', SECRET);
    expect(verifySetupToken(token, 'another-secret')).toBeNull();
  });

  it('签名被改一个字符 → null', () => {
    const { token } = signSetupToken('u-1', SECRET);
    const [payload, signature] = token.split('.');
    const flipped = signature.endsWith('A') ? 'B' : 'A';
    const tampered = `${String(payload)}.${String(signature).slice(0, -1)}${flipped}`;
    expect(verifySetupToken(tampered, SECRET)).toBeNull();
  });

  it('**换了 payload 但签名没跟着变 → null**(最关键的一条)', () => {
    // 攻击者想拿别人的签名把自己伪装成另一个用户。
    const victim = signSetupToken('u-victim', SECRET);
    const attacker = signSetupToken('u-attacker', SECRET);

    const victimPayload = victim.token.split('.')[0] ?? '';
    const attackerSignature = attacker.token.split('.')[1] ?? '';

    expect(verifySetupToken(`${victimPayload}.${attackerSignature}`, SECRET)).toBeNull();
  });

  it('格式不对的串 → null,且不抛异常', () => {
    for (const bad of ['', '.', 'abc', 'a.b.c', '..', 'no-dot', '.onlysig', 'onlypayload.']) {
      expect(verifySetupToken(bad, SECRET)).toBeNull();
    }
  });

  it('签名过了但 payload 缺字段或类型不对 → null', () => {
    const future = Date.UTC(2030, 0, 1);

    expect(verifySetupToken(forge({}, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ sub: 'u-1' }, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ exp: future }, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ sub: '', exp: future }, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ sub: 123, exp: future }, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ sub: 'u-1', exp: 'soon' }, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ sub: 'u-1', exp: null }, SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(forge({ sub: 'u-1', exp: Infinity }, SECRET), SECRET)).toBeNull();
  });

  it('payload 不是合法 JSON → null', () => {
    expect(verifySetupToken(signRaw('not json at all', SECRET), SECRET)).toBeNull();
  });

  it('payload 是合法 JSON 但不是对象 → null', () => {
    expect(verifySetupToken(signRaw('"just a string"', SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(signRaw('42', SECRET), SECRET)).toBeNull();
    expect(verifySetupToken(signRaw('null', SECRET), SECRET)).toBeNull();
  });
});
