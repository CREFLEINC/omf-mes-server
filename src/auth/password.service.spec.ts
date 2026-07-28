import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('해시·검증이 왕복한다', async () => {
    const hash = await service.hash('correct-horse-battery');

    await expect(service.verify('correct-horse-battery', hash)).resolves.toBe(true);
    await expect(service.verify('wrong-password', hash)).resolves.toBe(false);
  });

  it('같은 비밀번호도 매번 다른 해시가 나온다 — salt가 무작위다', async () => {
    const a = await service.hash('same-password');
    const b = await service.hash('same-password');

    expect(a).not.toBe(b);
    await expect(service.verify('same-password', a)).resolves.toBe(true);
    await expect(service.verify('same-password', b)).resolves.toBe(true);
  });

  it('알고리즘·파라미터를 해시에 담아 자기서술적이다', async () => {
    const hash = await service.hash('x-password-1');
    const [algo, n, r, p] = hash.split('$');

    expect(algo).toBe('scrypt');
    expect(Number(n)).toBe(2 ** 15);
    expect([Number(r), Number(p)]).toEqual([8, 1]);
    expect(hash.split('$')).toHaveLength(6);
  });

  // 저장된 해시의 상태 차이가 응답으로 새어나가면 안 된다 — 예외 대신 false.
  it.each([
    ['빈 문자열', ''],
    ['형식 불일치', 'not-a-hash'],
    ['알 수 없는 알고리즘', 'argon2$1$2$3$c2FsdA==$aGFzaA=='],
    ['필드 부족', 'scrypt$32768$8$1$c2FsdA=='],
    ['빈 salt', 'scrypt$32768$8$1$$aGFzaA=='],
  ])('깨진 해시(%s)는 예외 없이 false', async (_label, stored) => {
    await expect(service.verify('any-password', stored)).resolves.toBe(false);
  });

  // N=2^15·r=8은 128*N*r = 32MB로 Node 기본 maxmem(32MB)을 넘는다.
  // maxmem을 지정하지 않으면 ERR_CRYPTO_INVALID_SCRYPT_PARAMS로 터진다.
  it('현재 파라미터로 해싱이 메모리 한계에 걸리지 않는다', async () => {
    await expect(service.hash('memory-limit-check')).resolves.toContain('scrypt$32768$8$1$');
  });
});
