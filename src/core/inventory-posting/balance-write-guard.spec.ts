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

/** 같은 세 모양의 예약 판 — 조회(`FROM inventory.inventory_reservation`)와 참조표 문자열은 통과해야 한다. */
const RESERVATION_WRITES = [
  /UPDATE\s+inventory\.inventory_reservation/,
  /INSERT\s+INTO\s+inventory\.inventory_reservation/,
  /\.inventory_reservation\.(update|updateMany|create|createMany|upsert|delete)/,
];

const writersOf = (patterns: RegExp[]): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => {
      const source = readFileSync(join(SRC, name), 'utf8');
      return patterns.some((pattern) => pattern.test(source));
    })
    .sort();

describe('balance-write-guard', () => {
  it('inventory_balance 를 쓰는 파일은 src/core/inventory-posting 뿐이다', () => {
    const writers = writersOf(WRITES);

    expect(writers.filter((name) => !name.startsWith(CORE))).toEqual([]);
    // 헛통과가 아님을 보인다 — 코어 자신은 걸린다.
    expect(writers).toContain(`${CORE}inventory-posting.service.ts`);
    expect(writers).toContain(`${CORE}reservation-qty.ts`);
  });

  it('inventory_reservation 을 쓰는 파일도 src/core/inventory-posting 뿐이다', () => {
    const writers = writersOf(RESERVATION_WRITES);

    expect(writers.filter((name) => !name.startsWith(CORE))).toEqual([]);
    // 예약을 «거는» 길과 «푸는» 길이 둘 다 이 파일 하나다(I-22 §6-3).
    // spec 은 그 SQL 을 문자열로 단언해서 걸리므로 뺀다 — 남는 것이 «구현» 파일 전부다.
    expect(writers.filter((name) => !name.endsWith('.spec.ts'))).toEqual([
      `${CORE}reservation-qty.ts`,
    ]);
  });
});
