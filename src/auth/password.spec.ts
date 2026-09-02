import { randomBytes, scrypt } from 'node:crypto';

import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('해시한 비밀번호를 검증한다', async () => {
    const hash = await hashPassword('올바른-비밀번호');

    await expect(verifyPassword('올바른-비밀번호', hash)).resolves.toBe(true);
    await expect(verifyPassword('틀린-비밀번호', hash)).resolves.toBe(false);
  });

  it('같은 비밀번호도 해시가 매번 다르다 — 소금이 붙는다', async () => {
    expect(await hashPassword('같은값')).not.toBe(await hashPassword('같은값'));
  });

  it('해시에 파라미터가 담긴다 — 나중에 비용을 올려도 옛 해시를 검증할 수 있다', async () => {
    expect((await hashPassword('x')).split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
  });

  it('⭐ 시드가 만든 해시를 그대로 검증한다 — 형식이 갈리면 시드된 관리자가 못 들어온다', async () => {
    // prisma/seed.ts 의 해시 조립을 그대로 옮겨 쓴다. seed 는 운영에서 단일 파일로
    // transpile 되므로 여기서 import 할 수 없다 — 대신 두 구현을 맞대어 본다.
    const salt = randomBytes(16);
    const derived = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        '시드-비밀번호',
        salt,
        64,
        { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
    const seeded = ['scrypt', 2 ** 15, 8, 1, salt.toString('base64'), derived.toString('base64')].join(
      '$',
    );

    await expect(verifyPassword('시드-비밀번호', seeded)).resolves.toBe(true);
    await expect(verifyPassword('다른-비밀번호', seeded)).resolves.toBe(false);
  });

  it('⛔ 형식이 깨져도 던지지 않고 false 를 준다 — 던지면 500 이 나가 계정 상태가 드러난다', async () => {
    for (const broken of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$1$2$3$a$b', 'scrypt$x$8$1$a$b']) {
      await expect(verifyPassword('아무거나', broken)).resolves.toBe(false);
    }
  });
});
