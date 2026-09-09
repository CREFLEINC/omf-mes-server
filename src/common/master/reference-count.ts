import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 이 마스터를 FK 로 가리키는 자리 하나 — `['스키마.표', '컬럼']`. */
export type Referrer = readonly [table: string, column: string];

/**
 * 공유계약 `B-4`(참조 건수가 0일 때만 코드 수정 허용)를 위해 참조를 센다.
 *
 * ⛔ 가리키는 자리를 «손으로» 적는다. 창고 16곳, 로케이션 30곳이라 관계 이름만 보고
 * 짜면 반드시 빠뜨린다 — 컬럼 이름이 `warehouse_id`·`from_warehouse_id`·
 * `source_warehouse_id`·`destination_warehouse_id` 로 제각각이기 때문이다.
 *
 * 그래서 목록이 낡는 것이 이 코드의 진짜 위험이다. FK 가 새로 붙으면 여기 없는 채로
 * 「참조 0 → 코드 수정 허용」이 나온다 — 조용히 틀린다. e2e 가 `pg_constraint` 에서
 * 실제 목록을 뽑아 이 상수와 대조하므로, 새 FK 는 검사를 깨뜨려 드러난다.
 *
 * 한 번의 왕복으로 센다. 16~30번을 따로 돌면 상세 조회 하나가 그만큼 느려진다.
 */
export async function countReferences(
  prisma: Pick<PrismaService, '$queryRawUnsafe'>,
  referrers: readonly Referrer[],
  id: number | bigint,
): Promise<number> {
  // 표·컬럼 이름은 위 상수에서만 온다 — 요청 값이 섞이는 자리가 없다.
  const terms = referrers.map(
    ([table, column]) =>
      `(SELECT count(*) FROM ${table} WHERE ${column} = $1::bigint)`,
  );
  const rows = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT ${terms.join(' + ')} AS total`,
    id,
  );
  return Number(rows[0]?.total ?? 0);
}

/** 위 SQL 이 식별자를 어떻게 짜는지 검사가 그대로 쓴다. */
export function referenceCountSql(referrers: readonly Referrer[]): Prisma.Sql {
  return Prisma.raw(
    referrers.map(([t, c]) => `(SELECT count(*) FROM ${t} WHERE ${c} = $1::bigint)`).join(' + '),
  );
}
