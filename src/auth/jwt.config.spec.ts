import { readJwtConfig } from './jwt.config';

const VALID_SECRET = 'x'.repeat(32);

describe('readJwtConfig', () => {
  it('32자 이상 비밀키를 받는다', () => {
    expect(readJwtConfig({ JWT_SECRET: VALID_SECRET }).secret).toBe(VALID_SECRET);
  });

  it('비밀키가 없으면 던진다 — 기본값을 두면 약한 키로 조용히 운영에 올라간다', () => {
    expect(() => readJwtConfig({})).toThrow(/JWT_SECRET/);
  });

  it('비밀키가 32자 미만이면 던진다', () => {
    expect(() => readJwtConfig({ JWT_SECRET: 'x'.repeat(31) })).toThrow(/32자/);
  });

  it('만료 시간을 숫자로 바꾼다 — 문자열이면 jsonwebtoken 이 밀리초로 읽어 28초 만에 만료된다', () => {
    const config = readJwtConfig({ JWT_SECRET: VALID_SECRET, JWT_EXPIRES_IN_SECONDS: '28800' });

    expect(config.expiresInSeconds).toBe(28800);
    expect(typeof config.expiresInSeconds).toBe('number');
  });

  it.each([
    ['미지정', undefined],
    ['빈 문자열', ''],
    ['숫자가 아님', 'abc'],
    ['0', '0'],
    ['음수', '-1'],
    ['소수', '1.5'],
  ])('만료 시간이 %s 이면 기본값 8시간을 쓴다', (_label, value) => {
    const config = readJwtConfig({ JWT_SECRET: VALID_SECRET, JWT_EXPIRES_IN_SECONDS: value });

    expect(config.expiresInSeconds).toBe(28800);
  });
});
