import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../..');
const CORE = 'core/inventory-posting/';

/**
 * `inventory_balance` 를 **쓰는** 세 모양. 파일 단위 낱말 매칭은 오탐이 다섯(출고의
 * `SELECT … FOR UPDATE` · 잔액 조회의 `FROM` · 참조표 이름 문자열 둘 · 주석)이라
 * 읽기·문자열·주석은 통과해야 한다.
 */
const WRITES = [
  /UPDATE\s+inventory\.inventory_balance/,
  /INSERT\s+INTO\s+inventory\.inventory_balance/,
  // 접두 일치라 `deleteMany`·`updateManyAndReturn`·`createManyAndReturn` 도 잡는다 — `(` 를 붙이면 샌다.
  /\.inventory_balance\.(update|updateMany|create|createMany|upsert|delete)/,
];

describe('balance-write-guard', () => {
  it('inventory_balance 를 쓰는 파일은 src/core/inventory-posting 뿐이다', () => {
    const writers = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((name) => name.split('\\').join('/'))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => {
        const source = readFileSync(join(SRC, name), 'utf8');
        return WRITES.some((pattern) => pattern.test(source));
      })
      .sort();

    expect(writers.filter((name) => !name.startsWith(CORE))).toEqual([]);
    // 헛통과가 아님을 보인다 — 코어 자신은 걸린다.
    expect(writers).toContain(`${CORE}inventory-posting.service.ts`);
    expect(writers).toContain(`${CORE}reservation-qty.ts`);
  });
});
