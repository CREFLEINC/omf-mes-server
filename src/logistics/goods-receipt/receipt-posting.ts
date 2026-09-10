import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';

/**
 * 입고 «처리» 한 트랜잭션 — 전표 · 라인 · 원장 전기 · 잔액 · 적치 지시.
 *
 * ⭐ 「입고 전표 생성과 전기가 한 번에 일어난다」(계약 · W-01-10 §5-4 · 공유계약 B-8).
 * 화면이 「입고 처리」 한 버튼이므로 `:confirm`·`:post` 로 쪼개지 않는다.
 *
 * ⛔ **적치 «완료»는 이 트랜잭션 밖이다** — 「입고만 성공하고 적치가 남는 상태는 오류가
 * 아니라 표현 가능한 상태」(계약). 여기서는 지시를 «만들기»만 한다.
 *
 * ⛔ **LOT 보류를 풀지 않는다.** 「LOT 재고 상태(보류→가용)」와 「의심자재 보류 기록
 * (`trace.lot_hold`)」은 다른 축이고, 뒤의 것은 `W-03-02` 소관이다(설계팀 회신 2026-09-05 ·
 * 되돌림 §Z-8). 「LOT 재고 상태 전이」는 라인이 실어 보낸 `inventoryStatusCode` 로
 * **전기하는 것 자체**다 — 따로 고칠 LOT 컬럼이 없다.
 */

/** 원장 한 줄의 «성격». 계약이 넷으로 닫았다 — 늘리려면 계약을 고친다. */
const SOURCE_DOCUMENT_TYPE = 'GOODS_RECEIPT';
/** 생성과 전기가 같은 순간이라 `REGISTERED` 로 머무는 자리가 없다. */
const POSTED = 'POSTED';
const PUTAWAY_PENDING = 'PENDING';
/**
 * ⚠ **요청이 소유 구분을 싣지 않는다.** 잔량 차원(`uq_inventory_balance_dim`)에는 그 축이
 * 있는데 `GoodsReceiptLineCreate` 에는 칸이 없어 서버가 고를 수밖에 없다. 자사소유로 둔다 —
 * 고객지급품·위탁재고 입고는 이 값이 틀리므로 계약이 칸을 열면 그때 화면이 보낸다.
 */
const OWNERSHIP = 'OWNED';

export interface GoodsReceiptLineCreate {
  inboundReceiptLineId?: number | null;
  itemId: number;
  lotId: number;
  receiptQty: number;
  uomId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  destinationLocationId: number;
  originalShipmentLotAllocationId?: number | null;
}

export interface GoodsReceiptCreate {
  receiptTypeCode: string;
  plantId: number;
  warehouseId: number;
  receiptDatetime: string;
  sourceDocumentTypeCode?: string | null;
  sourceDocumentId?: number | null;
  reasonCode?: string | null;
  remarks?: string | null;
  businessDate: string;
  lines: GoodsReceiptLineCreate[];
}

/**
 * ⛔ 번호 둘은 **밖에서 뽑아 받는다** — 채번 카운터가 이 트랜잭션에 걸리면 같은
 * (유형·영업일) 입고가 전기·잔액·적치까지 한 줄로 서고, 롤백이 번호를 되돌려 호출자의
 * 재시도가 «같은 번호»를 다시 뽑는다(I-2.md R-2). `putawayNos` 는 **라인 수만큼** —
 * 적치 지시는 라인마다 하나다.
 *
 * ⭐⭐ **`putawayNos` 가 `null` 이면 적치 지시를 «만들지 않는다»**(I-23 PR ⑤ 가 더했다).
 * 긴급 직행 출하(`W-04-05`)는 **창고 경유를 건너뛰는** 경로라 장부상 입고 직후 그대로 나간다 —
 * 지시를 만들면 **현장 작업자가 `W-01-12` 에서 «유령 작업»을 본다**(물건이 이미 없다).
 * ⛔ 빈 배열로 대신하지 마라 — `putawayNos[index]` 가 `undefined` 가 되어 NOT NULL 위반 500 이다.
 */
export async function postReceipt(
  tx: Prisma.TransactionClient,
  posting: InventoryPostingService,
  input: GoodsReceiptCreate,
  appUserId: number,
  receiptNo: string,
  putawayNos: string[] | null,
): Promise<bigint> {
  const receipt = await tx.goods_receipt.create({
    data: {
      goods_receipt_no: receiptNo,
      receipt_type_code: input.receiptTypeCode,
      plant_id: input.plantId,
      warehouse_id: input.warehouseId,
      receipt_datetime: new Date(input.receiptDatetime),
      status_code: POSTED,
      source_document_type_code: input.sourceDocumentTypeCode ?? null,
      source_document_id: input.sourceDocumentId ?? null,
      reason_code: input.reasonCode ?? null,
      remarks: input.remarks ?? null,
      created_by: BigInt(appUserId),
    },
  });

  const lines: bigint[] = [];
  for (const [index, line] of input.lines.entries()) {
    const created = await tx.goods_receipt_line.create({
      data: {
        goods_receipt_id: receipt.goods_receipt_id,
        line_no: index + 1,
        inbound_receipt_line_id: line.inboundReceiptLineId ?? null,
        item_id: line.itemId,
        lot_id: line.lotId,
        receipt_qty: line.receiptQty,
        uom_id: line.uomId,
        quality_status_code: line.qualityStatusCode,
        inventory_status_code: line.inventoryStatusCode,
        destination_location_id: line.destinationLocationId,
        original_shipment_lot_allocation_id: line.originalShipmentLotAllocationId ?? null,
        created_by: BigInt(appUserId),
      },
    });
    lines.push(created.goods_receipt_line_id);
  }

  // ⛔ 재고를 바꾸는 유일한 길이다 — 도메인이 `inventory_balance` 를 직접 쓰지 않는다.
  //    전표 번호를 그대로 원장 번호로 쓴다: 채번이 하나면 두 표를 사람이 맞대 볼 수 있다.
  const posted = await posting.post(tx, {
    businessDate: input.businessDate,
    // ⛔ 영업일은 클라이언트가 보낸 값이다(C-8). `occurredAt` 은 그것과 «다른» 축 —
    //    실제로 일어난 시각이라 입고 일시를 그대로 쓴다.
    occurredAt: new Date(input.receiptDatetime),
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    transactionNo: receiptNo,
    statusCode: POSTED,
    plantId: input.plantId,
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(receipt.goods_receipt_id),
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${receiptNo}`,
    createdBy: appUserId,
    // 도착지만 있고 출발지가 없다 — 그것이 「들어왔다」의 표현이다(원장은 유형 표를 두지 않는다).
    lines: input.lines.map((line) => ({
      itemId: line.itemId,
      lotId: line.lotId,
      qty: line.receiptQty,
      uomId: line.uomId,
      to: {
        warehouseId: input.warehouseId,
        locationId: line.destinationLocationId,
        qualityStatusCode: line.qualityStatusCode,
        inventoryStatusCode: line.inventoryStatusCode,
      },
      ownershipTypeCode: OWNERSHIP,
    })),
  });

  // posting 은 라인을 받은 «순서»대로 `line_no` 를 매긴다 — 그래서 자리로 짝지을 수 있다.
  const ledger = await tx.inventory_transaction_line.findMany({
    where: {
      inventory_transaction_id: posted.inventoryTransactionId,
      business_date: new Date(`${input.businessDate}T00:00:00.000Z`),
    },
    orderBy: { line_no: 'asc' },
    select: { inventory_transaction_line_id: true },
  });
  // 전표 번호가 유일하고 멱등키가 거기서 나오므로 흡수가 일어날 수 없다. 그래도 어긋나면
  // 라인이 «남의 원장»을 가리키게 되므로, 조용히 어긋나느니 트랜잭션을 되돌린다.
  if (ledger.length !== lines.length) {
    throw new Error(`원장 라인 수가 입고 라인과 다르다: ${ledger.length} ≠ ${lines.length}`);
  }

  for (const [index, goodsReceiptLineId] of lines.entries()) {
    await tx.goods_receipt_line.update({
      where: { goods_receipt_line_id: goodsReceiptLineId },
      data: { inventory_transaction_line_id: ledger[index].inventory_transaction_line_id },
    });
    if (putawayNos === null) continue;
    await createPutawayTask(
      tx,
      receipt,
      input.lines[index],
      goodsReceiptLineId,
      putawayNos[index],
      appUserId,
    );
  }

  return receipt.goods_receipt_id;
}

/**
 * 라인마다 적치 지시 하나. 「적치 지시는 라인마다 서버가 함께 만들고, 응답의
 * `GoodsReceiptLine.putawayTaskId` 가 그 식별자를 싣는다」(계약).
 *
 * ⛔ 권장 위치는 **적치 규칙만이 낸다**(`M-01-05` §5-2-1 · 2026-08-06 확정). 라인이 보낸
 * `destinationLocationId` 는 「입고 전기 시점의 장부 위치」이지 적치 판정이 아니다 —
 * 그래서 그 값은 «출발지»(`from_location_id`)가 된다.
 */
async function createPutawayTask(
  tx: Prisma.TransactionClient,
  receipt: { goods_receipt_id: bigint; warehouse_id: bigint },
  line: GoodsReceiptLineCreate,
  goodsReceiptLineId: bigint,
  putawayTaskNo: string,
  appUserId: number,
): Promise<void> {
  const rule = await tx.putaway_rule.findFirst({
    where: {
      item_id: line.itemId,
      warehouse_id: receipt.warehouse_id,
      is_active: true,
      // 위치를 못 내는 규칙은 권장도 못 낸다 — 「비어 있으면 이 품목에 관리 위치가 없다」(계약).
      location_id: { not: null },
    },
    // 「작을수록 먼저 권장한다」(계약 `PutawayRule.priorityNo`).
    orderBy: [{ priority_no: 'asc' }, { putaway_rule_id: 'asc' }],
    select: { putaway_rule_id: true, location_id: true },
  });

  await tx.putaway_task.create({
    data: {
      putaway_task_no: putawayTaskNo,
      goods_receipt_line_id: goodsReceiptLineId,
      item_id: line.itemId,
      lot_id: line.lotId,
      task_qty: line.receiptQty,
      uom_id: line.uomId,
      from_location_id: line.destinationLocationId,
      recommended_location_id: rule?.location_id ?? null,
      applied_putaway_rule_id: rule?.putaway_rule_id ?? null,
      status_code: PUTAWAY_PENDING,
      created_by: BigInt(appUserId),
    },
  });
}
