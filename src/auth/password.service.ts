import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/**
 * `promisify(scrypt)`은 오버로드 중 옵션 없는 3인자 형태만 잡혀 파라미터를 넘길 수 없다.
 * 옵션을 쓰는 오버로드를 직접 감싼다.
 */
const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });

/**
 * scrypt 파라미터.
 *
 * N=2^15·r=8·p=1은 OWASP 권고선(N≥2^15)이며 해시 1회에 약 100ms 수준이다.
 * 로그인 빈도가 낮은 관리 화면이라 이 비용은 문제가 되지 않고, 무차별 대입에는 충분한 벽이 된다.
 */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt가 쓰는 메모리는 대략 `128 * N * r` 바이트다(N=2^15·r=8 → 32MB).
 * Node의 기본 maxmem이 32MB라 그대로 두면 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`로 터진다.
 * 넉넉히 2배를 준다.
 */
const scryptMaxmem = (n: number, r: number): number => 128 * n * r * 2;

const PREFIX = 'scrypt';

/**
 * 비밀번호 해싱.
 *
 * **Node 내장 scrypt를 쓴다.** argon2id가 최신 권고지만 npm 구현이 네이티브 빌드를 요구하고,
 * 배포가 오프라인 설치 패키지(결정 15)라 빌드 툴체인 의존을 늘리지 않는 편이 낫다.
 * scrypt도 메모리 하드 KDF로 비밀번호 해싱에 적합하다.
 *
 * 알고리즘 전환이 필요하면 `user_credential.password_algo`와 해시 문자열의 접두사로
 * 구분되므로, 검증 시 옛 해시를 읽으면서 점진적으로 재해싱할 수 있다.
 */
@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(plain, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R),
    });

    return [
      PREFIX,
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  /**
   * 검증. 형식이 깨졌거나 알 수 없는 알고리즘이면 **예외 대신 false**를 돌려준다 —
   * 저장된 해시의 상태 차이가 응답으로 새어나가지 않게 한다.
   */
  async verify(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== PREFIX) return false;

    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    let derived: Buffer;
    try {
      derived = await scryptAsync(plain, salt, expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: scryptMaxmem(Number(n), Number(r)),
      });
    } catch {
      return false;
    }

    // 길이가 다르면 timingSafeEqual이 던진다 — 먼저 확인한다.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }
}
