import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';

/**
 * 적치 완료가 쌓는 **원장 한 줄** — 하역장(`from`) → 실제 위치(`to`). `receipt-posting.ts` 의 짝.
 * ⭐ **결정 — 통보 059**(2026-09-08). 판별자는 `STOCK_TRANSFER` 를 그대로 쓰고,
 * **`transaction_no` 의 `PT-` 접두어가 「적치가 쓴 행」을 가르는 정본 판별 규칙**이다.
 *   적치        : `source_document_type_code='STOCK_TRANSFER' AND transaction_no LIKE 'PT-%'`
 *   재고 이동   : 같은 판별자 + `NOT LIKE 'PT-%'` (I-13)
 * ⛔ 레인 C 에 전달됨 — I-13 의 진짜 재고이동은 `PT-` 를 쓰지 않는다.
 * (아래는 그 결정에 이른 사정이다.) 판별자 값은 「대상 테이블 이름」인데 적치에는
 * `logistics.stock_transfer` 헤더가 **없다** — `sourceDocumentId` 는 `putaway_task_id` 다.
 * enum 이 4값으로 닫혀 다섯째 값은 조회 계약을 깨고, `GOODS_RECEIPT` 는 다형 취소의
 * 「2행이면 던진다」에 걸려 입고 취소를 죽인다. ⛔ **되돌릴 수 없다** —
 * `block_ledger_header_mutation` 이 `status_code` 밖의 UPDATE·DELETE 를 전부 막는다.
 */
const SOURCE_DOCUMENT_TYPE = 'STOCK_TRANSFER';
const POSTED = 'POSTED';

/**
 * 출발 끝점 — 입고 원장 라인의 `to_*` 를 **그대로 복제**한 것(지어내면 다른 차원을 깎는다).
 * ⭐ 앞 4칸은 `PostingEndpoint`, 뒤 3칸은 **라인 칸**이라 갈라 쓴다.
 */
export interface PutawayOrigin {
  warehouseId: number; locationId: number; qualityStatusCode: string; inventoryStatusCode: string;
  ownershipTypeCode: string; ownerPartnerId: number | null; handlingUnitId: number | null;
}

export interface PutawayMove {
  businessDate: string; occurredAt: Date; plantId: number;
  putawayTaskId: number; putawayTaskNo: string;
  itemId: number; lotId: number; qty: Prisma.Decimal; uomId: number;
  origin: PutawayOrigin; toWarehouseId: number; toLocationId: number; createdBy: number;
}

/** 돌려주는 것은 지시가 되짚을 원장 **라인** id 다. */
export async function postPutaway(
  tx: Prisma.TransactionClient,
  posting: InventoryPostingService,
  move: PutawayMove,
): Promise<bigint> {
  const { origin } = move;
  const posted = await posting.post(tx, {
    businessDate: move.businessDate,
    occurredAt: move.occurredAt,
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    // 지시 번호(`PT-`)를 그대로 원장 번호로 쓴다 — 채번을 새로 두지 않는다(입고 선례).
    transactionNo: move.putawayTaskNo,
    statusCode: POSTED,
    plantId: move.plantId,
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: move.putawayTaskId,
    // 헤더값이 아니라 «결정적» 키다 — 같은 지시를 다른 키로 두 번 완료해도 원장이 하나다.
    idempotencyKey: `PUTAWAY_TASK:${move.putawayTaskNo}`,
    createdBy: move.createdBy,
    // ⭐ 품질·재고 상태를 **바꾸지 않는다** — 적치는 옮길 뿐 판정하지 않는다. 바꾸면 잔액이
    //    다른 차원으로 넘어가 「적치했더니 검사 대기가 정상이 됐다」가 된다.
    lines: [{
      itemId: move.itemId, lotId: move.lotId, qty: Number(move.qty), uomId: move.uomId,
      from: {
        warehouseId: origin.warehouseId, locationId: origin.locationId,
        qualityStatusCode: origin.qualityStatusCode, inventoryStatusCode: origin.inventoryStatusCode,
      },
      to: {
        warehouseId: move.toWarehouseId, locationId: move.toLocationId,
        qualityStatusCode: origin.qualityStatusCode, inventoryStatusCode: origin.inventoryStatusCode,
      },
      ownershipTypeCode: origin.ownershipTypeCode,
      ...(origin.ownerPartnerId === null ? {} : { ownerPartnerId: origin.ownerPartnerId }),
      ...(origin.handlingUnitId === null ? {} : { handlingUnitId: origin.handlingUnitId }),
    }],
  });
  // 흡수가 오면 잔액은 안 옮겨졌는데 되짚기와 전이는 돈다 — 상태 자물쇠를 지나쳤다는 뜻이다.
  if (posted.alreadyPosted) throw new Error(`원장이 이미 있다: ${move.putawayTaskNo}`);

  const [ledger] = await tx.inventory_transaction_line.findMany({
    where: {
      inventory_transaction_id: posted.inventoryTransactionId,
      business_date: new Date(`${move.businessDate}T00:00:00.000Z`),
    },
    orderBy: { line_no: 'asc' },
    select: { inventory_transaction_line_id: true },
  });
  if (ledger === undefined) throw new Error(`원장 라인이 서지 않았다: ${move.putawayTaskNo}`);
  return ledger.inventory_transaction_line_id;
}
