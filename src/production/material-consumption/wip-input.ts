import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { WORK_ORDER_LOT_SOURCE, wipQuantities, wipRemaining } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { isPreviousOperation } from './wip-input-rules';

/** 남은 투입 가능 수량을 넘는 반제품 투입(409) — 원장이 없어 실적·투입 합으로 막는다(피처 016 FR-011). */
export const WIP_QTY_EXCEEDED = 'WIP_QTY_EXCEEDED';

/** 투입 W/O — 품목과 그 공정의 Routing·순번. */
export interface WipInputWorkOrder {
  item_id: bigint;
  routing_operation: { routing_id: bigint; operation_seq: number };
}

/** 반제품 LOT — 품목과 만든 W/O(원천). */
export interface WipInputLot {
  item_id: bigint;
  source_type_code: string;
  source_id: bigint;
}

/**
 * 반제품 투입의 참조 판정(R-3) — BOM 대신 «같은 품목 → 바로 앞 공정»을 본다. 트랜잭션 «밖»이다.
 * 수량은 잠금 안에서 본다(`assertWipRemainingWithin`).
 */
export async function assertWipInput(prisma: PrismaService, workOrder: WipInputWorkOrder, lot: WipInputLot): Promise<void> {
  if (lot.item_id !== workOrder.item_id) throw one(field('lotId', ERROR_CODE.INVALID, '다른 품목의 반제품입니다.'));
  const { routing_id, operation_seq } = workOrder.routing_operation;
  const [produced, before] = await Promise.all([
    lot.source_type_code === WORK_ORDER_LOT_SOURCE
      ? prisma.work_order.findUnique({
          where: { work_order_id: lot.source_id },
          select: { routing_operation: { select: { process_id: true } } },
        })
      : null,
    prisma.routing_operation.findMany({
      where: { routing_id, operation_seq: { lt: operation_seq } },
      select: { operation_seq: true, process_id: true },
    }),
  ]);
  if (produced === null || !isPreviousOperation(before, operation_seq, produced.routing_operation.process_id)) {
    throw one(field('lotId', ERROR_CODE.INVALID, '이 W/O 의 앞 공정 반제품이 아닙니다.'));
  }
}

/**
 * 남은 수량 — LOT 행을 잠근 «뒤» 다시 센다. 두 단말이 같은 반제품을 동시에 넣으면 뒤엣것이 앞엣것의 투입을 보고 막힌다.
 * `FOR NO KEY UPDATE` — LOT 을 참조하는 행(투입·계보)의 FK 잠금과 부딪히지 않는다.
 */
export async function assertWipRemainingWithin(tx: Prisma.TransactionClient, lotId: bigint, inputQty: number): Promise<void> {
  await tx.$queryRaw`SELECT lot_id FROM trace.lot WHERE lot_id = ${lotId} FOR NO KEY UPDATE`;
  const quantity = (await wipQuantities(tx, [lotId])).get(lotId) ?? { produced: new Prisma.Decimal(0), consumed: new Prisma.Decimal(0) };
  const remaining = wipRemaining(quantity);
  if (new Prisma.Decimal(inputQty).lessThanOrEqualTo(remaining)) return;
  throw new ContractException(
    HttpStatus.CONFLICT,
    [field('inputQty', WIP_QTY_EXCEEDED, `남은 수량을 넘습니다 (남은 ${remaining.toString()})`)],
    // 화면 문구 「남은 수량(n)보다 많이 넣었습니다. 실적 p 중 c 은 이미 투입했습니다.」의 근거 — 투입 = 실적 − 남은.
    { meta: { remainingQty: remaining.toNumber(), producedQty: quantity.produced.toNumber() } },
  );
}
