import { Prisma } from '@prisma/client';

import { PageMeta } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { BuiltQuery, FROM, SELECT_COLUMNS } from './disposition-query';
import { DispositionRemainingSummary, remainingSummary } from './disposition-rollup';
import { DispositionDecisionRow, DispositionDecisionView, dispositionDecisionView } from './disposition-view';

/**
 * `GET /quality/nonconformances/{nonconformanceId}/disposition-decisions`(I-21 PR ②b). 계약
 * 질의 칸이 **0** 이고 `page` 는 늘 전건이다(§1-2) — `disposition-query.ts` 의 `SELECT_COLUMNS`·
 * `FROM`(export 만 늘렸다 · 복제가 아니다)을 그대로 쓰되 LIMIT/OFFSET 을 안 붙인다(51번째가
 * 조용히 사라지면 안 된다). `summary` 의 잔량 산식은 `disposition-rollup.ts` 의
 * `remainingSummary()` 를 그대로 부른다 — 계약 `DispositionRemainingSummary.x-internal-note`
 * 가 판정 저장의 내부 주석과 「한 글자도 다르지 않아야」한다고 못 박았다(§0 판정 #2).
 *
 * ⛔ 없는 `nonconformanceId` 는 404 가 «아니다» — 계약이 이 오퍼레이션 응답을 200 하나만
 * 선언했다(§1-1 · §1-6 「404 는 계약이 선언한 자리만」). 같은 계약 파일의 형제 자식-컬렉션
 * 오퍼레이션(`GET …/{inspectionResultId}/measurements` · `inspection-measurement.service.ts:list`
 * 실측)이 이미 「존재를 따로 확인하지 않고 필터만 걸어, 0행이면 빈 목록」으로 판정해 뒀다
 * (`quality-inspection-summary.e2e-spec.ts:318` — 「404 가 아니다 — 계약 미선언」). `summary.uomId`
 * 는 실을 값이 없으면 `0` — 계약이 `minimum` 을 안 줘 ajv 가 통과하고, 없는 것을 있는 척 도출하지
 * 않는다(README §2 2단계 기준 4). // 결정 — 통보 후보(번호는 통합자가 준다)
 */
export interface DispositionsByNonconformance {
  items: DispositionDecisionView[];
  page: PageMeta;
  summary: DispositionRemainingSummary;
}

function query(nonconformanceId: number): BuiltQuery {
  return {
    sql: `SELECT ${SELECT_COLUMNS} ${FROM} WHERE d.nonconformance_id = $1::bigint ORDER BY d.decided_at DESC, d.disposition_decision_id DESC`,
    params: [nonconformanceId],
  };
}

/**
 * 대상 수량·단위 — `nonconformance_lot` 이 하나도 없으면(없는 `nonconformanceId` 포함) `0`.
 * 물리는 `nonconformance` 에 `uom_id` 칸이 없다(§1-4-1) — lot 이 있으면 그중 하나(§1-3 이 「전부
 * 같기를」 강제), 없으면 품목 기준 단위로 접는다(선례 `nonconformance-view.ts` PR 리뷰 Minor-3).
 */
async function targetOf(prisma: PrismaService, nonconformanceId: number): Promise<{ affectedQtyTotal: Prisma.Decimal; uomId: number }> {
  const nc = await prisma.nonconformance.findUnique({
    where: { nonconformance_id: BigInt(nonconformanceId) },
    select: { item: { select: { base_uom_id: true } }, nonconformance_lot: { select: { affected_qty: true, uom_id: true } } },
  });
  if (!nc) return { affectedQtyTotal: new Prisma.Decimal(0), uomId: 0 };

  const lots = nc.nonconformance_lot;
  const affectedQtyTotal = lots.reduce((sum, lot) => sum.add(lot.affected_qty), new Prisma.Decimal(0));
  return { affectedQtyTotal, uomId: lots.length > 0 ? Number(lots[0].uom_id) : Number(nc.item.base_uom_id) };
}

export async function dispositionsByNonconformance(prisma: PrismaService, nonconformanceId: number): Promise<DispositionsByNonconformance> {
  const built = query(nonconformanceId);
  const [rows, target] = await Promise.all([prisma.$queryRawUnsafe<DispositionDecisionRow[]>(built.sql, ...built.params), targetOf(prisma, nonconformanceId)]);
  const items = rows.map((row) => dispositionDecisionView(row).view);
  // ⭐ `Prisma.Decimal` 로 합해 마지막에만 `.toNumber()`(①a Major-2 선례) — `remainingSummary()`
  // 가 그 마지막 자리를 이미 진다.
  const decidedQtyTotal = rows.reduce((sum, row) => sum.add(new Prisma.Decimal(String(row.decision_qty))), new Prisma.Decimal(0));

  return {
    items,
    page: { page: 1, size: items.length, total: items.length },
    summary: remainingSummary(target.affectedQtyTotal, decidedQtyTotal, target.uomId),
  };
}
