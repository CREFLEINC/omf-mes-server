import { Prisma } from '@prisma/client';

import { LOT_SPLIT_SOURCE } from './lot-source';

type Tx = Prisma.TransactionClient;

/** 계보 행(`trace.lot_relation`)의 축 — 분할은 수량이 그대로 옮겨 가므로 정확하다. */
const SPLIT_RELATION = 'SPLIT';
const EXACT = 'EXACT';
const SPLIT_SUFFIX = '-S';

export interface LotSplitInput {
  parentLotId: bigint;
  qty: Prisma.Decimal;
  /** 이 분할을 일으킨 문서 — 계보 행이 되짚는다(예: `DISPOSITION_DECISION`). */
  sourceEventTypeCode: string;
  sourceEventId: bigint;
  occurredAt: Date;
  createdBy: bigint | null;
}

export interface LotSplitResult {
  lotId: bigint;
  lotNo: string;
}

/**
 * LOT 분할 — 원 LOT 에서 수량 일부를 떼어 **자식 LOT** 을 만든다(omf-all-around#108 · 장부 P-53).
 *
 * ⭐ 자식은 원 LOT 의 «지금 상태»로 태어난다 — 떼어 낸 수량은 그 순간 원 LOT 과 같은 상태였다. 다른
 *    상태로 보내는 일은 호출자가 전이(`moveWithin`)로 한다 — 상태 이력을 쓰는 자리를 하나로 둔다.
 * ⭐ 번호는 `원번호-S{n}` — 같은 원 LOT 의 몇 번째 분할인가. 공장 안 유일(`uq_lot`)을 지킨다.
 * ⛔ 재고(원장)는 옮기지 않는다 — 위치·품질 차원을 고를 축이 여기 없다. 호출자가 원장으로 옮긴다.
 * ⛔ 원 LOT 의 `initial_qty` 를 줄이지 않는다 — 「처음 만든 수량」이다. 남은 수량은 원장이 말한다.
 */
export async function splitLotWithin(tx: Tx, input: LotSplitInput): Promise<LotSplitResult> {
  const parent = await tx.lot.findUniqueOrThrow({
    where: { lot_id: input.parentLotId },
    select: {
      lot_no: true, item_id: true, lot_type_code: true, plant_id: true, uom_id: true,
      status_code: true, manufactured_at: true, expiry_date: true, bom_id: true, bom_version: true,
    },
  });
  const siblings = await tx.lot.count({ where: { parent_lot_id: input.parentLotId } });
  const lotNo = `${parent.lot_no}${SPLIT_SUFFIX}${String(siblings + 1)}`;
  const child = await tx.lot.create({
    data: {
      lot_no: lotNo,
      item_id: parent.item_id,
      lot_type_code: parent.lot_type_code,
      plant_id: parent.plant_id,
      initial_qty: input.qty,
      uom_id: parent.uom_id,
      source_type_code: LOT_SPLIT_SOURCE,
      source_id: input.parentLotId,
      parent_lot_id: input.parentLotId,
      status_code: parent.status_code,
      manufactured_at: parent.manufactured_at,
      expiry_date: parent.expiry_date,
      // ⛔ BOM 은 id·버전을 «함께» 옮긴다 — `ck_lot_bom_snapshot`((bom_id IS NULL) = (bom_version IS NULL)).
      bom_id: parent.bom_id,
      bom_version: parent.bom_version,
      created_by: input.createdBy,
    },
    select: { lot_id: true, lot_no: true },
  });
  await tx.lot_relation.create({
    data: {
      source_lot_id: input.parentLotId,
      target_lot_id: child.lot_id,
      relation_type_code: SPLIT_RELATION,
      relation_qty: input.qty,
      uom_id: parent.uom_id,
      source_event_type_code: input.sourceEventTypeCode,
      source_event_id: input.sourceEventId,
      allocation_method_code: EXACT,
      trace_accuracy_code: EXACT,
      occurred_at: input.occurredAt,
      created_by: input.createdBy,
    },
  });
  return { lotId: child.lot_id, lotNo: child.lot_no };
}
