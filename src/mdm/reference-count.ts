import { PrismaService } from '../prisma/prisma.service';

export type ReferenceColumn = { schema: string; table: string; column: string };

/** e2e 가 정본의 `pg_constraint` 와 대조할 때 쓴다. */
export function referenceKey({ schema, table, column }: ReferenceColumn): string {
  return `${schema}.${table}.${column}`;
}

/**
 * 이 마스터 행을 가리키는 건수 합계. 스칼라 서브쿼리를 하나로 묶어 DB 왕복을 1회로 둔다 —
 * 로케이션은 참조가 26곳이라 왕복하면 상세 조회 한 번에 26번이다.
 *
 * 식별자는 호출부의 상수 목록에서만 오고 값은 파라미터로 나간다. 목록이 손으로 적힌
 * 것이므로, 각 마스터의 e2e 가 그 목록을 `pg_constraint` 와 대조한다 — 하나 빠지면
 * **쓰이고 있는 행이 「수정 가능」으로 잘못 판정된다.**
 */
export async function countReferences(
  prisma: PrismaService,
  references: readonly ReferenceColumn[],
  id: bigint,
): Promise<number> {
  const terms = references
    .map(({ schema, table, column }) => `(SELECT count(*) FROM ${schema}.${table} WHERE ${column} = $1)`)
    .join(' + ');

  const [{ total }] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT ${terms} AS total`,
    id,
  );

  return Number(total);
}
