import { PageRequest, pagedResponse } from '../../common/pagination';
import { BuiltSql, PagedWithTotals, UomTotalRow, lineTotals } from '../../logistics/line-list';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 기간별 이력(투입·포장) 목록의 한 쪽과 합계. `from` 은 `FROM ... JOIN ...` 이고 단위 열은 `uomColumn` 이다.
 * 합계(줄 수·단위별 수량)는 쪽과 무관하게 필터 전체를 센다 — 입고 줄·출하 줄 현황(장부 P-119)과 같다.
 */
export async function historyLinePage<Row, Item>(
  prisma: PrismaService,
  parts: { select: string; from: string; qtyColumn: string; uomColumn: string; orderBy: string },
  where: BuiltSql,
  page: PageRequest,
  itemOf: (row: Row) => Item,
): Promise<PagedWithTotals<Item>> {
  const next = where.params.length;
  const [rows, totals] = await Promise.all([
    prisma.$queryRawUnsafe<Row[]>(
      `SELECT ${parts.select} ${parts.from}
        WHERE ${where.sql}
        ORDER BY ${parts.orderBy}
        LIMIT $${next + 1} OFFSET $${next + 2}`,
      ...where.params, page.take, page.skip,
    ),
    prisma.$queryRawUnsafe<UomTotalRow[]>(
      `SELECT tu.uom_id, tu.uom_code, SUM(${parts.qtyColumn}) AS qty, COUNT(*) AS line_count ${parts.from}
         JOIN mdm.uom tu ON tu.uom_id = ${parts.uomColumn}
        WHERE ${where.sql}
        GROUP BY tu.uom_id, tu.uom_code
        ORDER BY tu.uom_code`,
      ...where.params,
    ),
  ]);
  const result = lineTotals(totals);
  return { ...pagedResponse(rows.map(itemOf), result.lineCount, page), totals: result };
}
