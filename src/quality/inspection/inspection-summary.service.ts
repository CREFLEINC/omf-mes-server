import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { buildInspectionResultWhere, FINAL_ROUND_SELECT } from './inspection-result-query.service';
import { assertPeriodRequired, finalRoundOf } from './inspection-rules';

/** `summary` 의 질의 10 — 목록에서 `page`·`size`·`sort`·`lotId` 를 뺀 것이다(§1-2). */
export interface InspectionSummaryQuery {
  inspectionRequestId?: number;
  inspectionTypeCode?: string;
  overallJudgmentCode?: string;
  statusCode?: string;
  processId?: number;
  itemId?: number;
  inspectedFrom?: string;
  inspectedTo?: string;
  finalRoundOnly?: boolean;
  // ⚠ 계약의 `calibrationExpired`(only·exclude)와 응답 `calibrationExpiredCount` 는 **PR ⑤b** 가
  //   같은 커밋에서 연다 — 교정 만료 판정(`calibration.ts` · R-13)이 측정치 2건과 함께 서기
  //   때문이다. ⛔ 근거 없이 칸만 받아 두면 «조용히 무시»가 된다(#298 m-1 이 그 자리였다).
}

/** `defect-rate-trend` 의 질의 8 — 위에서 `inspectionRequestId`·`statusCode` 가 빠진다(계약 실측). */
export type DefectRateTrendQuery = Omit<InspectionSummaryQuery, 'inspectionRequestId' | 'statusCode'>;

const SCOPE_SELECT = {
  ...FINAL_ROUND_SELECT,
  inspected_qty: true,
  accepted_qty: true,
  rejected_qty: true,
  held_qty: true,
  inspected_at: true,
} as const;
type ScopeRow = Prisma.inspection_resultGetPayload<{ select: typeof SCOPE_SELECT }>;

/**
 * 집계 2건 — `summary`·`defect-rate-trend`(I-19 PR ⑤a). **서버가 센다**(L-1·L-2): 화면은 페이지를
 * 받아 더하지 않는다. ⚠ 교정 만료 축(`calibrationExpired` 필터 · `calibrationExpiredCount`)은
 * **PR ⑤b** 가 측정치 2건과 «같은 커밋»에서 연다 — 판정이 없는데 칸만 받으면 조용히 무시가 된다.
 *
 * ⭐ R-12 — `finalRoundOnly` 의 기본값이 계약에 없다. **집계 셋은 `true`** 다(목록만 `false`).
 * 도면 수가 그 근거다(요약 412 · 목록 412 · 결과 ~450) — `false` 로 두면 1회차 불합격과 재검
 * 합격이 «둘 다» 세어져 불량률이 반토막 난다(§4-5 · `W-03-05` §5-3).
 * ⭐ R-17 — 기간은 **무조건 필수**다. 목록의 조건부 규칙과 다른 함수를 부른다.
 *
 * ⚠ 집계 축은 `inspection_result` **한 표**다(계약이 적은 규모 ~450행) — 좁은 칸만 읽어
 *   메모리에서 접는다. 135,000 자릿수인 측정치를 이렇게 접지 않는다(그쪽은 §4-3 페이지 조회다).
 */
@Injectable()
export class InspectionSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(query: InspectionSummaryQuery) {
    const rows = await this.scope(query);
    const inspected = sumOf(rows, 'inspected_qty');
    const rejected = sumOf(rows, 'rejected_qty');

    return {
      inspectionCount: rows.length,
      inspectedQty: inspected.toNumber(),
      acceptedQty: sumOf(rows, 'accepted_qty').toNumber(),
      rejectedQty: rejected.toNumber(),
      heldQty: sumOf(rows, 'held_qty').toNumber(),
      // ⭐ 분모는 **검사 수량**이다 — 생산 수량이 아니다(`W-02-08` 수율과 다른 수가 정상 · QA #13).
      defectRate: defectRateOf(inspected, rejected),
      // ⚠ `calibrationExpiredCount` 는 아직 «키가 없다»(계약 optional) — PR ⑤b 몫이다.
      //    ⛔ 0 을 채우면 「만료 장비로 잰 검사가 없다」로 읽혀 §5-6 의 경고가 영영 안 뜬다(L-8).
      finalRoundOnly: finalRoundOnlyOf(query),
      asOf: new Date().toISOString(),
    };
  }

  /** 일자 버킷. ⭐ 축은 **UTC 날짜**다 — 결과에 공장 칸이 없어 `plant.timezone_code` 로 풀 자리가 없다. */
  async trend(query: DefectRateTrendQuery) {
    const rows = await this.scope(query);
    const buckets = new Map<string, { inspected: Prisma.Decimal; rejected: Prisma.Decimal }>();
    for (const row of rows) {
      const bucket = row.inspected_at.toISOString().slice(0, 10);
      const point = buckets.get(bucket) ?? { inspected: new Prisma.Decimal(0), rejected: new Prisma.Decimal(0) };
      buckets.set(bucket, { inspected: point.inspected.add(row.inspected_qty), rejected: point.rejected.add(row.rejected_qty) });
    }

    return {
      // ⛔ 검사가 0건인 날은 **점이 없다** — 0 으로 채우면 「그날 전수 합격」과 구분이 사라진다(L-8).
      points: [...buckets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucket, point]) => ({
          bucket,
          inspectedQty: point.inspected.toNumber(),
          rejectedQty: point.rejected.toNumber(),
          defectRate: defectRateOf(point.inspected, point.rejected),
        })),
      asOf: new Date().toISOString(),
    };
  }

  private async scope(query: InspectionSummaryQuery): Promise<ScopeRow[]> {
    assertPeriodRequired(query);
    const where = buildInspectionResultWhere(query);
    const rows = await this.prisma.inspection_result.findMany({ where, select: SCOPE_SELECT });

    return finalRoundOnlyOf(query) ? finalRoundOf(rows) : rows;
  }
}

/** ⭐ R-12 — 생략은 `true` 다. 「false 로 왔을 때만」 사슬 전건을 센다. */
const finalRoundOnlyOf = (query: { finalRoundOnly?: boolean }): boolean => query.finalRoundOnly !== false;

/** `Decimal(20,6)` 합. 부동소수로 더하면 수량 합이 화면에서 어긋난다. */
function sumOf(rows: ScopeRow[], column: 'inspected_qty' | 'accepted_qty' | 'rejected_qty' | 'held_qty'): Prisma.Decimal {
  return rows.reduce((sum, row) => sum.add(row[column]), new Prisma.Decimal(0));
}

/**
 * 백분율. ⚠ 분모가 0 이면 **0 을 낸다** — 계약이 `defectRate` 를 required 로 적어 키를 생략할 수
 * 없다(「판정 불가」와 「불량 0%」가 구분되지 않는다 · 「알려둘 것」 ⓓ).
 * ⛔ 반올림하지 않는다 — 계약이 자릿수를 안 적었고 표시 자릿수는 화면 몫이다.
 */
const defectRateOf = (inspected: Prisma.Decimal, rejected: Prisma.Decimal): number =>
  inspected.isZero() ? 0 : rejected.div(inspected).mul(100).toNumber();
