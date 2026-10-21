import { randomBytes } from 'node:crypto';

import { SecretBox } from './secret-box';

const KEY = randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('왕복 복원하고 저장 형식이 v1:iv:tag:ct 다', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('refresh-토큰-원문');
    expect(sealed.split(':')).toHaveLength(4);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(Buffer.from(sealed.split(':')[1], 'base64')).toHaveLength(12);
    expect(sealed).not.toContain('refresh');
    expect(box.open(sealed)).toBe('refresh-토큰-원문');
  });

  it('같은 평문도 iv 가 달라 암호문이 매번 다르다', () => {
    const box = new SecretBox(KEY);
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('SC-008 키가 다르거나 변조됐으면 실패한다', () => {
    const sealed = new SecretBox(KEY).seal('secret');
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open(sealed)).toThrow();
    const [v, iv, tag, ct] = sealed.split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => new SecretBox(KEY).open([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
    expect(() => new SecretBox(KEY).open('plain-text')).toThrow();
  });

  it('키가 32바이트가 아니면 만들 때 던진다', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow();
    expect(() => new SecretBox('')).toThrow();
  });
});
