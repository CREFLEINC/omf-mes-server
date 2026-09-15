import type { Prisma } from '@prisma/client';

import { labelDateTime, labelQty } from './material-lot-label';
import type { MaterialLotLabelValues } from './material-lot-label-layout';

/**
 * 생산 LOT 라벨의 값 — **배치는 자재 LOT 라벨과 «같은» 80×30mm 판**을 쓴다
 * (`material-lot-label-layout.ts`). 판을 새로 짜지 않는 이유가 둘이다:
 *   ⓐ POP 셸과 목업이 그 배치(`SIZE ` 시그니처·좌표)를 전제로 돌아간다 — 판이 갈리면
 *      단말마다 출력물이 달라지지 않게 하려던 규약이 깨진다.
 *   ⓑ 라벨을 읽는 쪽이 보는 것은 **LOT 번호 하나**다(P-02-04 의 스캔 칸이 `lotNo` 문자열
 *      정확 일치). 2D 코드에 LOT 번호를 그대로 싣는 규약(통보 277)도 같다.
 *
 * ⛔ **품명 줄을 넣지 않는다** — 자재 라벨이 「품명 줄이 없다(277 결정 5)」로 일부러 뺀 자리이고,
 *    80×30mm 여섯 줄에 품명을 더 넣으면 품목 코드·LOT 번호가 잘린다. 대신 머리줄에 **W/O 번호**를
 *    싣는다(현장이 「이 라벨이 어느 지시의 산출인가」를 먼저 본다).
 * ⛔ 공장·공정은 싣지 않는다 — 판에 남는 줄이 없다. 라벨은 한 공장 안에서만 돌고, 공정은 W/O
 *    번호로 되짚을 수 있다.
 */

/** 이 라벨이 읽는 칸만. 값이 없으면 빈 칸으로 그린다 — 발행은 이미 됐으므로 422 로 막지 않는다. */
export interface ProductionLotLabelRow {
  issue_seq: number;
  issued_at: Date;
  lot: {
    lot_no: string;
    status_code: string;
    initial_qty: Prisma.Decimal;
    item: { item_code: string };
    uom: { uom_code: string };
    plant: { timezone_code: string };
  };
  /** 이 LOT 에 배분된 양품 누계와 가장 최근 실적 시각. 실적이 없으면 둘 다 비운다. */
  allocation: { qty: Prisma.Decimal | null; occurredAt: Date | null };
  /** 원천 W/O 번호. 못 풀면 빈 문자열이다. */
  workOrderNo: string;
}

export function productionLotLabelValues(row: ProductionLotLabelRow): MaterialLotLabelValues {
  const { lot } = row;
  // ⭐ 수량은 «실제로 난 양»이다 — 배분 누계. 자재 라벨의 `initial_qty`(입고량)에 대응하는 값이
  //    생산에서는 실적 배분이다. 아직 배분이 없으면(마감 뒤 재발행 등 경계) 계획 수량으로 갈음한다.
  const qty = row.allocation.qty ?? lot.initial_qty;
  return {
    type: 'PROD',
    status: lot.status_code,
    partNo: lot.item.item_code,
    qty: labelQty(qty, lot.uom.uom_code),
    lotNo: lot.lot_no,
    // 생산일 = 실적이 난 시각. 없으면 발행 시각으로 갈음한다(둘 다 공장 시간대로 푼다).
    mfgDt: labelDateTime(row.allocation.occurredAt ?? row.issued_at, lot.plant.timezone_code),
    issueSeq: row.issue_seq,
    workOrderNo: row.workOrderNo,
  };
}
