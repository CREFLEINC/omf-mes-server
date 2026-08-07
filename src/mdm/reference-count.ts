import { PrismaService } from '../prisma/prisma.service';

export type ReferenceColumn = { schema: string; table: string; column: string };

/** e2e 가 정본의 `pg_constraint` 와 대조할 때 쓴다. */
export function referenceKey({ schema, table, column }: ReferenceColumn): string {
  return `${schema}.${table}.${column}`;
}

/**
 * 식별자는 파라미터로 묶을 수 없어 SQL 문자열에 그대로 들어간다. 지금 호출부는 전부
 * 모듈 상수지만, 마스터가 늘수록 이 함수를 부르는 곳도 는다 — 한 곳이 실수로 요청
 * 값을 흘리면 여기가 마지막 방어선이다.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`참조 목록에 쓸 수 없는 식별자: ${value}`);

  return value;
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
    .map(
      ({ schema, table, column }) =>
        `(SELECT count(*) FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}` +
        ` WHERE ${quoteIdentifier(column)} = $1)`,
    )
    .join(' + ');

  const [{ total }] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT ${terms} AS total`,
    id,
  );

  return Number(total);
}
