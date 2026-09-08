import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { conditionsOf, FROM_TRANS_ONLY, LotStatusFilters } from './lot-status-query';

/**
 * `LOT_STATUS` 4값(시드 순서 — `NORMAL`·`INSPECTION_PENDING`·`DEFECTIVE`·`SCRAPPED`).
 * ⭐ **R-16 판정** — 계획안 §4-1 이 적은 「없는 조합의 칸을 0 으로 만들지 않는다」는 재수립이
 * 뒤집은 폐기 문구다. 근거: `W-03-01:209`(「요약 카드는 **4값 전건**을 센다」 · 2026-08-07
 * 회신 E-3 종결) · `:218`(「구 문구 폐기 — 4값 확정으로 대기 안내 불요」). `:216`의 「0 이 아니라
 * ⓘ 대기」 박스는 **그 폐기된 구 문구 자신**(미확정 상태를 셀 수 없던 시절의 표기)이지, 지금
 * 확정된 4값에 적용되는 규칙이 아니다.
 */
const LOT_STATUS_VALUES = ['NORMAL', 'INSPECTION_PENDING', 'DEFECTIVE', 'SCRAPPED'] as const;

interface SummaryRow {
  status_code: string;
  lot_type_code: string;
  cnt: number;
}

/** 계약 `LotStatusCount` 과 동형(required 2: statusCode·lotCount). */
export interface LotStatusCount {
  statusCode: string;
  lotTypeCode?: string;
  lotCount: number;
}

/**
 * 계약 `LotStatusSummary` 와 동형(required 2: counts·asOf).
 * // 결정 — 통보 073: `outOfScopeCount` 는 늘 키를 생략한다 — `user_data_scope` 를 적용하는
 * 조회가 저장소에 0건이라 「범위 밖」이 존재하지 않는다(0 을 채우면 「없다」와 「모른다」가
 * 같은 모양이 된다 · L-8). `docs/design-inquiries/073-outOfScopeCount-적용-조회-0건.md`.
 */
export interface LotStatusSummaryView {
  counts: LotStatusCount[];
  asOf: string;
}

@Injectable()
export class LotStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /quality/lot-status-summary` — 목록(`lot-status.controller.ts`)과 **같은 WHERE**(
   * `conditionsOf`)로 부른다(계약 x-internal-note · `W-03-01` §5-7). 묶는 축은
   * `statusCode × lotTypeCode` — 셋을 합치지 않는다(공유계약 L-7). ⭐ `FROM` 은 목록과
   * 다르다 — `FROM_TRANS_ONLY`(잔액·보류 LATERAL 없이 `trans` 만)를 쓴다. WHERE 절 필터는
   * `bal`·`hold` 별칭을 참조하지 않으므로 모집단 동일성(§4-1)은 그대로다(m-4).
   */
  async summary(filters: LotStatusFilters): Promise<LotStatusSummaryView> {
    const asOf = new Date().toISOString();
    const c = conditionsOf(filters);
    const sql = `
      SELECT l.status_code, l.lot_type_code, count(*)::int AS cnt
        ${FROM_TRANS_ONLY}
       WHERE ${c.where}
       GROUP BY l.status_code, l.lot_type_code
       ORDER BY l.status_code, l.lot_type_code`;
    const rows = await this.prisma.$queryRawUnsafe<SummaryRow[]>(sql, ...c.params);

    return { counts: countsOf(rows), asOf };
  }
}

/**
 * ⭐ **R-16** — `LOT_STATUS` 4값은 실재하는 조합이 하나도 없어도 `{statusCode, lotCount: 0}` 한
 * 행을 낸다 — **`lotStatusCode` 필터가 왔어도 언제나 4값 전건이다**(필터는 WHERE 절에서 모집단만
 * 좁힌다 · `conditionsOf`). `:209` 「요약 카드는 4값 전건을 센다」·`:283` 「요약 카드 5종」을
 * 문자 그대로 읽으면 필터가 걸려도 카드는 4장이다 — 「다른 상태로 갈아타는」 카드를 그리려면
 * 나머지 3장(값 0)이 필요하다(리뷰 #354 Major M-1 · 권고안 ⓐ).
 * ⛔ **`lotTypeCode` 축은 격자 전체가 아니다** — 실재하는 조합만 낸다. 근거: `LotStatusCount
 * .lotTypeCode` 는 required 밖(`statusCode`·`lotCount` 만 required)이고, `W-03-01` §5-4 가
 * 「4값 전건」이라 부르는 자리는 상태 축(정상·불량·검사대기·폐기)만 다룬다 — 유형(자재·생산·
 * 제품)은 그 절에 등장하지 않는다. 상태 자체가 0건이면 어느 유형인지 알 수 없어(「모른다」)
 * `lotTypeCode` 키를 생략한다(공유계약 L-8).
 * // 결정 — 통보 083: §2 2단계 기준 4(값을 조용히 도출하지 않는 쪽) ⇒ 격자 전체(4×3)를 지어내지
 * 않는다. `docs/design-inquiries/083-lotTypeCode-축은-격자-전체가-아니다.md`.
 */
function countsOf(rows: SummaryRow[]): LotStatusCount[] {
  const byStatus = new Map<string, LotStatusCount[]>();
  for (const row of rows) {
    const cells = byStatus.get(row.status_code) ?? [];
    cells.push({ statusCode: row.status_code, lotTypeCode: row.lot_type_code, lotCount: row.cnt });
    byStatus.set(row.status_code, cells);
  }

  return LOT_STATUS_VALUES.flatMap((statusCode) => byStatus.get(statusCode) ?? [{ statusCode, lotCount: 0 }]);
}
