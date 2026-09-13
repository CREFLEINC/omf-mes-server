import { Prisma } from '@prisma/client';

import { PageMeta } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalQualityReadScope, terminalQualityWorkOrderWhere } from '../../auth/terminal-quality-read-scope';
import { NotFoundException } from '@nestjs/common';
import { dispositionByNonconformanceQuery } from './disposition-query';
import { DispositionRemainingSummary, remainingSummary } from './disposition-rollup';
import { DispositionDecisionRow, DispositionDecisionView, dispositionDecisionView } from './disposition-view';

/**
 * `GET /quality/nonconformances/{nonconformanceId}/disposition-decisions`(I-21 PR ②b). 계약
 * 질의 칸이 **0** 이고 `page` 는 늘 전건이다(§1-2) — 행 조회는 `disposition-query.ts` 의
 * `dispositionByNonconformanceQuery()`(LIMIT/OFFSET 없음 · SQL 조립은 그 파일 안에 갇혀 있다)를
 * 그대로 부른다. `summary` 의 잔량 산식은 `disposition-rollup.ts` 의 `remainingSummary()` 를
 * 그대로 부른다 — 계약 `DispositionRemainingSummary.x-internal-note` 가 판정 저장의 내부 주석과
 * 「한 글자도 다르지 않아야」한다고 못 박았다(§0 판정 #2).
 *
 * ⛔ 없는 `nonconformanceId` 는 404 가 «아니다» — 계약이 이 오퍼레이션 응답을 200 하나만
 * 선언했다(§1-1 · §1-6 「404 는 계약이 선언한 자리만」). ⚠ 저장소가 이 축으로 «갈려» 있다 —
 * 계약 미선언인데도 404 를 내는 자식-컬렉션이 따로 있다(예: `GET …/goods-issues/{id}/lines` ·
 * `GET …/boms/{id}/components`). 이 오퍼레이션은 **같은 계약 파일의** 형제 자식-컬렉션
 * (`GET …/{inspectionResultId}/measurements` · `inspection-measurement.service.ts:list` 실측)을
 * 따랐다 — 존재를 따로 확인하지 않고 필터만 걸어, 0행이면 빈 목록(`quality-inspection-summary.
 * e2e-spec.ts:318` 「404 가 아니다 — 계약 미선언」). ⭐ `summary.uomId` 의 `0` 은 «도출»이 «아니다»
 * — 200 을 내기로 한 이상 required·널불가 정수(계약 `minimum` 미선언)에 실을 다른 값이 없어
 * 강제된 값이고, 노출 반경도 0 이다: 실재하는 부적합은 `item_id` NOT NULL 이라 아래 폴백이 언제나
 * 서고, `uomId: 0` 은 없는 부적합에서만 나오는데 그 화면(`W-03-10`)은 ①b 상세에서 이미 404 를
 * 받는다. // 결정 — 통보 후보(번호는 통합자가 준다)
 */
export interface DispositionsByNonconformance {
  items: DispositionDecisionView[];
  page: PageMeta;
  summary: DispositionRemainingSummary;
}

/**
 * 대상 수량·단위 — `nonconformance_lot` 이 하나도 없으면(없는 `nonconformanceId` 포함) `0`.
 * 물리는 `nonconformance` 에 `uom_id` 칸이 없다(§1-4-1) — lot 이 있으면 **그 합**을 대상 수량으로
 * 싣고, 단위는 그중 «첫» LOT 것(§1-3 이 「전부 같기를」 강제 · `nonconformance_lot_id asc` 로
 * 순서를 고정한다 — 선례 `nonconformance-view.ts` 의 `NONCONFORMANCE_INCLUDE`). lot 이 없으면
 * 품목 기준 단위로 접는다(선례 `nonconformance-view.ts` PR 리뷰 Minor-3).
 */
async function targetOf(prisma: PrismaService, nonconformanceId: number): Promise<{ affectedQtyTotal: Prisma.Decimal; uomId: number }> {
  const nc = await prisma.nonconformance.findUnique({
    where: { nonconformance_id: BigInt(nonconformanceId) },
    select: {
      item: { select: { base_uom_id: true } },
      nonconformance_lot: { orderBy: { nonconformance_lot_id: 'asc' }, select: { affected_qty: true, uom_id: true } },
    },
  });
  if (!nc) return { affectedQtyTotal: new Prisma.Decimal(0), uomId: 0 };

  const lots = nc.nonconformance_lot;
  const affectedQtyTotal = lots.reduce((sum, lot) => sum.add(lot.affected_qty), new Prisma.Decimal(0));
  return { affectedQtyTotal, uomId: lots.length > 0 ? Number(lots[0].uom_id) : Number(nc.item.base_uom_id) };
}

export async function dispositionsByNonconformance(
  prisma: PrismaService, nonconformanceId: number, scope?: TerminalQualityReadScope,
): Promise<DispositionsByNonconformance> {
  if (scope !== undefined) {
    const owned = await prisma.nonconformance.findFirst({
      where: { nonconformance_id: BigInt(nonconformanceId),
        work_order_nonconformance_work_order_idTowork_order: terminalQualityWorkOrderWhere(scope) },
      select: { nonconformance_id: true },
    });
    if (!owned) throw new NotFoundException('없는 부적합입니다.');
  }
  const built = dispositionByNonconformanceQuery(nonconformanceId);
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
