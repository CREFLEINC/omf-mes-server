import { randomBytes, scrypt } from 'node:crypto';

import { PasswordService } from './password.service';

/** `prisma/seed.ts` 가 admin 해시를 만드는 절차를 그대로 옮긴 것. */
async function seedStyleHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 }, (e, d) =>
      e ? reject(e) : resolve(d as Buffer),
    ),
  );

  return ['scrypt', 2 ** 15, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');
}

describe('PasswordService', () => {
  const service = new PasswordService();

  it('자기가 만든 해시를 검증한다', async () => {
    const hash = await service.hash('올바른 비밀번호');

    await expect(service.verify('올바른 비밀번호', hash)).resolves.toBe(true);
  });

  it('시드가 만든 해시를 검증한다 — 형식이 어긋나면 admin 으로 로그인할 수 없다', async () => {
    const hash = await seedStyleHash('시드 비밀번호');

    await expect(service.verify('시드 비밀번호', hash)).resolves.toBe(true);
  });

  it('저장 형식이 시드와 같다 — scrypt$N$r$p$salt$hash', async () => {
    const parts = (await service.hash('x')).split('$');

    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5], 'base64')).toHaveLength(64);
  });

  it('틀린 비밀번호를 거부한다', async () => {
    const hash = await service.hash('올바른 비밀번호');

    await expect(service.verify('틀린 비밀번호', hash)).resolves.toBe(false);
  });

  it('같은 비밀번호라도 매번 다른 해시가 나온다 — salt 가 무작위다', async () => {
    const [a, b] = await Promise.all([service.hash('같은 것'), service.hash('같은 것')]);

    expect(a).not.toBe(b);
  });

  it.each([
    ['빈 문자열', ''],
    ['구분자가 모자람', 'scrypt$32768$8$1$salt'],
    ['알고리즘이 다름', 'argon2$32768$8$1$c2FsdA==$aGFzaA=='],
    ['파라미터가 숫자가 아님', 'scrypt$abc$8$1$c2FsdA==$aGFzaA=='],
    ['salt 가 비어 있음', 'scrypt$32768$8$1$$aGFzaA=='],
  ])('깨진 해시(%s)에 던지지 않고 false 를 준다', async (_label, stored) => {
    // 자격증명 하나가 손상됐다고 로그인 경로가 500 으로 죽으면 안 된다.
    await expect(service.verify('아무거나', stored)).resolves.toBe(false);
  });
});
