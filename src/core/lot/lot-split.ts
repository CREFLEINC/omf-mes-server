import { Prisma } from '@prisma/client';

import { SPLIT_RELATION } from './lot-genealogy';
import { splitLotNoFamily, splitMaterialLotNo } from './lot-number';

type Tx = Prisma.TransactionClient;

/** 계보 행(`trace.lot_relation`)의 축 — 분할은 수량이 그대로 옮겨 가므로 정확하다. */
const EXACT = 'EXACT';

export interface LotSplitInput {
  parentLotId: bigint;
  qty: Prisma.Decimal;
  /** 자식 LOT 의 원천(`lot.source_type_code`·`source_id`) — 예: `GOODS_ISSUE_SPLIT`·출고 라인 id. */
  sourceTypeCode: string;
  sourceId: bigint;
  /** 이 분할을 일으킨 문서 — 계보 행이 되짚는다(예: `GOODS_ISSUE_LINE`). */
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
 * 분할 번호 가족마다 트랜잭션 자물쇠 — 같은 LOT 을 다른 위치에서 동시에 나눠도 `-S` 차례가 겹치지 않는다
 * (피처 008 R-6). 정렬된 순서로 잡아 교착을 피한다. 같은 트랜잭션이 다시 잡아도 막히지 않는다.
 */
export async function lockLotSplitFamilies(tx: Tx, parentLotNos: readonly string[]): Promise<void> {
  const keys = [...new Set(parentLotNos.map((no) => `lot-split:${splitLotNoFamily(no).lockKey}`))].sort();
  if (keys.length === 0) return;
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(k, 0))::text
      FROM unnest(${keys}::text[]) AS k ORDER BY k`;
}

/**
 * LOT 분할 — 원 LOT 에서 수량 일부를 떼어 **자식 LOT** 을 만든다(omf-all-around#108 · 피처 008).
 *
 * ⭐ 자식은 원 LOT 의 «지금 상태»(품질·생애)로 태어난다 — 떼어 낸 수량은 그 순간 원 LOT 과 같은 상태였다.
 * ⭐ 번호는 `splitMaterialLotNo` — 수량 칸 = 분할 수량, 번호 칸 + `-S{n}`. 공장 안 유일(`uq_lot`)을 지킨다.
 * ⛔ 입하 LOT 칸은 비운다 — 채우면 입하 LOT 마감·IQC·입하 집계가 자식을 한 번 더 센다. 입하 LOT 은 부모를
 *    따라 올라가 보인다(피처 008 FR-003).
 * ⛔ 재고(원장)는 옮기지 않는다 — 위치·품질 차원을 고를 축이 여기 없다. 호출자가 원장으로 옮긴다.
 * ⛔ 원 LOT 의 `initial_qty` 를 줄이지 않는다 — 「처음 만든 수량」이다. 남은 수량은 원장이 말한다.
 */
export async function splitLotWithin(tx: Tx, input: LotSplitInput): Promise<LotSplitResult> {
  const parent = await tx.lot.findUniqueOrThrow({
    where: { lot_id: input.parentLotId },
    select: {
      lot_no: true, item_id: true, lot_type_code: true, plant_id: true, uom_id: true,
      status_code: true, lifecycle_status_code: true, manufactured_at: true, expiry_date: true,
      bom_id: true, bom_version: true,
    },
  });
  await lockLotSplitFamilies(tx, [parent.lot_no]);
  const family = splitLotNoFamily(parent.lot_no);
  const relatives = await tx.lot.findMany({
    where: { plant_id: parent.plant_id, lot_no: { startsWith: family.startsWith, contains: family.contains } },
    select: { lot_no: true },
  });
  const child = await tx.lot.create({
    data: {
      lot_no: splitMaterialLotNo(parent.lot_no, input.qty, relatives.map((row) => row.lot_no)),
      item_id: parent.item_id,
      lot_type_code: parent.lot_type_code,
      plant_id: parent.plant_id,
      initial_qty: input.qty,
      uom_id: parent.uom_id,
      source_type_code: input.sourceTypeCode,
      source_id: input.sourceId,
      parent_lot_id: input.parentLotId,
      status_code: parent.status_code,
      lifecycle_status_code: parent.lifecycle_status_code,
      manufactured_at: parent.manufactured_at,
      expiry_date: parent.expiry_date,
      // ⛔ BOM 은 id·버전을 «함께» 옮긴다 — `ck_lot_bom_snapshot`((bom_id IS NULL) = (bom_version IS NULL)).
      bom_id: parent.bom_id,
      bom_version: parent.bom_version,
      // 패키징은 옮기지 않는다 — 떼어 낸 수량은 패키징 곱과 맞지 않는다(R-4).
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
