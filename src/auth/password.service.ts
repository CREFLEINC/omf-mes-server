import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from 'node:crypto';

// promisify(scrypt) 의 타입은 options 를 받는 오버로드를 고르지 못한다 — 직접 감싼다.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    ),
  );
}

/**
 * scrypt 파라미터. **`prisma/seed.ts` 의 admin 해시 생성과 같아야 한다** —
 * 어긋나면 시드가 만든 계정으로 로그인할 수 없다.
 *
 * `maxmem` 을 명시하지 않으면 해싱 자체가 실패한다. 필요량 `128*N*r` = 32MB 가
 * Node 기본 maxmem 과 같아 경계에서 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` 가 난다.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAXMEM = 128 * N * R * 2;

const ALGO = 'scrypt';

@Injectable()
export class PasswordService {
  /**
   * 저장 형식은 `scrypt$N$r$p$salt$hash` 다. 알고리즘과 파라미터를 해시에 함께 담아
   * 자기서술적으로 만든다 — 나중에 파라미터를 올리거나 알고리즘을 바꿔도 옛 해시를
   * 그대로 읽으며 로그인 시점에 점진적으로 다시 해싱할 수 있다.
   */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await scryptAsync(password, salt, KEY_BYTES, {
      N,
      r: R,
      p: P,
      maxmem: MAXMEM,
    });

    return [ALGO, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
  }

  /**
   * 저장된 해시가 깨져 있어도 던지지 않고 false 를 준다 — 자격증명 하나가 손상됐다고
   * 로그인 경로가 500 으로 죽으면 안 된다.
   */
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = this.parse(stored);
    if (!parsed) return false;

    const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });

    // 길이가 다르면 timingSafeEqual 이 던진다. 앞에서 길이를 맞춰 두었지만 방어한다.
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  }

  private parse(
    stored: string,
  ): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== ALGO) return null;

    const [, n, r, p, salt, hash] = parts;
    const parsed = {
      n: Number(n),
      r: Number(r),
      p: Number(p),
      salt: Buffer.from(salt, 'base64'),
      hash: Buffer.from(hash, 'base64'),
    };

    const positiveInts = [parsed.n, parsed.r, parsed.p].every(
      (value) => Number.isInteger(value) && value > 0,
    );
    if (!positiveInts || parsed.salt.length === 0 || parsed.hash.length === 0) return null;

    return parsed;
  }
}
