import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * `scrypt$N$r$p$salt$derived` — 시드(`prisma/seed.ts`)가 쓰는 형식 그대로다.
 * 파라미터를 해시에 담아 두면 나중에 비용을 올려도 옛 해시를 그대로 검증할 수 있다.
 */
const PREFIX = 'scrypt';
const KEY_LENGTH = 64;
const DEFAULT = { N: 2 ** 15, r: 8, p: 1 };

function maxmem(N: number, r: number): number {
  // 기본값(32MB)으로는 N=2^15 가 「memory limit exceeded」로 죽는다.
  return 128 * N * r * 2;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...DEFAULT,
    maxmem: maxmem(DEFAULT.N, DEFAULT.r),
  });

  return [PREFIX, DEFAULT.N, DEFAULT.r, DEFAULT.p, salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

/**
 * ⛔ 형식이 깨졌거나 알고리즘이 다르면 «던지지 않고 false» 를 준다.
 * 던지면 500 이 나가고, 그 차이만으로 「이 계정의 해시가 이상하다」가 드러난다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, rawN, rawR, rawP, rawSalt, rawDerived] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(rawDerived, 'base64');
    const derived = await scrypt(password, Buffer.from(rawSalt, 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: maxmem(N, r),
    });
    // 길이가 다르면 timingSafeEqual 이 던진다 — 먼저 거른다.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
