import { randomBytes } from 'node:crypto';

/**
 * LOT 번호 — 출처가 둘이고 실패의 «성격»이 다르다(계약 `POST /trace/lots`).
 *
 * | 출처 | 번호 | 충돌하면 |
 * |---|---|---|
 * | `SUPPLIER` | 스캔한 값이 그대로 | **400** — 사람이 스캔값을 고쳐야 풀린다 |
 * | `MES` | 서버가 매긴다 | **409** — 서버가 먼저 다시 뽑고, 그래도 안 되면. 다시 부르면 풀린다 |
 *
 * ⛔ MES 충돌에 400 을 내지 않는다 — 「사용자가 고칠 수 있는 값이 아니기 때문」(계약).
 *
 * ⚠ 형식은 계약이 **34자리 고정폭만** 확정했다(MLOT #16). 도출·검증 규칙은 정하지
 * 않았으므로 아래는 서버가 고른 것이고, 규칙이 확정되면 이 파일만 바뀐다(되돌림 §Z-1).
 */

export const LOT_NO_LENGTH = 34;

/** 사람이 라벨에서 읽고 받아 적는 값이라 헷갈리는 글자(0·O·1·I)를 뺀다. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * `M` + 공장 6 + `YYYYMMDD` 8 + 그날 순번 6 + 난수 13 = **34자**.
 *
 * 순번은 「몇 번째로 발번했나」를 사람이 읽게 하고, 난수는 같은 순간에 두 건이 들어와도
 * 부딪히지 않게 한다. 부딪히면 호출자가 다시 부른다.
 */
export function mesLotNo(plantId: number, businessDate: string, todaySeq: number): string {
  const no =
    'M' +
    String(plantId).padStart(6, '0').slice(-6) +
    businessDate.replace(/-/g, '') +
    String(todaySeq).padStart(6, '0').slice(-6) +
    randomChars(13);
  return no;
}

function randomChars(length: number): string {
  // ⛔ `%` 로 자르지 않고 버리고 다시 뽑는다 — 256 이 알파벳 길이의 배수가 아니면
  // 나머지 연산이 앞쪽 글자를 더 자주 뽑는다(모듈로 편향).
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
