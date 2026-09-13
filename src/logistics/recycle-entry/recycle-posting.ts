import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { LotRegistryService } from '../../core/lot';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { LogisticsWriteActor } from '../logistics-write-actor';

/**
 * 재생재 등록 한 트랜잭션 — 등록 건 · LOT · 원장 전기 · 잔액.
 * 「새 자재 LOT 을 만들고 **그 수량만큼 재고를 늘린다 — 한 트랜잭션이다**」(계약).
 *
 * ⭐⭐ **판별자**(질의 213 → ⓐ · 2026-09-10 합의 · 계약 사본 선반영 #572) — 자기 값을 쓴다:
 * enum description 이 스스로 「값은 «대상 테이블 이름»이고 **가리킬 표가 늘면 계약을 고친다**」
 * 라 적은 그 경우다. ⛔ 남의 값을 **빌리지 않는다** — `GOODS_RECEIPT` 는 다형 취소가 한 문서에서
 * 원장 2행을 만나 500 을 내고(`document-cancel-execute.service.ts:139-152`), `INVENTORY_ADJUSTMENT`
 * 는 조정 상세에 재생재 원장이 «유령»으로 붙는다(질의 축에 `sourceDocumentId` 가 없다).
 * ⛔ `transaction_type_code` 를 **판별에 쓰지 않는다** — 계약이 「따로 두지 않는다(L-2-1)」로 금지
 * 했다. 값만 판별자와 같게 넣는다(선례 넷이 그 모양 · `putaway-posting.ts:47`).
 */
const SOURCE_DOCUMENT_TYPE = 'RECYCLE_ENTRY';
/** 생성과 전기가 같은 순간이라 `REGISTERED` 로 머무는 자리가 없다(입고와 같은 판정). */
const POSTED = 'POSTED';
/**
 * `mdm.item.mes_category_code` 와 **같은 값 영역**이다 — 그 칸의 옛 이름이 `recycle_type_code`
 * 였다(`20260903100000_rename_item_mes_columns`). 시드 `MES_CATEGORY` 2값(`NEW`·`RECYCLED`)
 * 중 재생재다. ⛔ 새 코드 그룹 0(F-6).
 */
const RECYCLE_TYPE = 'RECYCLED';
/** 계약이 「새 **자재** LOT」이라 적었다(시드 `LOT_TYPE` 3값 중 하나). */
const MATERIAL_LOT_TYPE = 'MATERIAL';
/**
 * 같은 트랜잭션이 만든 LOT 이 `INSPECTION_PENDING` 이라 잔액의 품질 축도 **그 값**이다(기준 4).
 * ⭐ 재고 축은 **독립**이라 `AVAILABLE` 이다 — 보류는 LOT 표식이고 잔액 차원을 거울처럼
 * 따라가지 않는다(`test/logistics-goods-receipt.e2e-spec.ts:400·420`).
 */
const LOT_QUALITY_STATUS = 'INSPECTION_PENDING';
const INVENTORY_AVAILABLE = 'AVAILABLE';
/** 본문에 소유 축이 0개다 — 자사소유로 둔다(`receipt-posting.ts:30` 의 같은 판정). */
const OWNERSHIP = 'OWNED';

/** 계약 `RecycleEntryCreate` — 프로퍼티 7 · required 6. ⛔ 단위·구분은 본문에 없다. */
export interface RecycleEntryCreate {
  itemId: number;
  quantity: number;
  warehouseId: number;
  locationId: number;
  businessDate: string;
  occurredAt: string;
  /** ⚠ 계약은 `"string"` 하나다 — `null` 은 도달 불가라 타입에 두지 않는다(A 리뷰 Nit ③). */
  remarks?: string;
}

/** 번호 둘과 서버가 역산한 축 둘은 **트랜잭션 밖에서** 정해져 온다(§4-1·§6). */
interface RecycleEntryWriteBase {
  input: RecycleEntryCreate;
  recycleEntryNo: string;
  lotNo: string;
  plantId: number;
  uomId: number;
}
export type RecycleEntryWrite = RecycleEntryWriteBase &
  ({ actor: LogisticsWriteActor; appUserId?: never } | { actor?: never; appUserId: number });

/**
 * 순서 불변식(입하와 같은 모양): ① 등록 건 INSERT(`lot_id = NULL`) ← `lot.source_id` 가 이 id 라
 * 먼저 서야 한다 ② `createWithin` ③ `lot_id` UPDATE ④ 원장 전기(`lotId` 가 정해진 뒤).
 * ⛔ **코어를 0줄 고친다** — 역방향 칸을 채우는 가지는 코어에 `INBOUND_RECEIPT_LINE` 에만 있다
 * (`lot-registry.service.ts:120`). 그 가지를 더하는 대신 **호출자가** 같은 `tx` 로 UPDATE 한다.
 */
export async function postRecycleEntry(
  tx: Prisma.TransactionClient,
  posting: InventoryPostingService,
  lots: LotRegistryService,
  write: RecycleEntryWrite,
): Promise<bigint> {
  const actor: LogisticsWriteActor = write.actor ?? { appUserId: write.appUserId as number };
  const { input } = write;
  const entry = await tx.recycle_entry.create({
    data: {
      recycle_entry_no: write.recycleEntryNo,
      plant_id: write.plantId,
      item_id: input.itemId,
      recycle_type_code: RECYCLE_TYPE,
      recycle_qty: input.quantity,
      uom_id: write.uomId,
      warehouse_id: input.warehouseId,
      destination_location_id: input.locationId,
      status_code: POSTED,
      // `POSTED` 인데 처리 시각이 비면 두 칸이 모순된다. ⛔ 수신 시각을 쓰지 않는다(C-8 계열).
      processed_at: new Date(input.occurredAt),
      remarks: input.remarks ?? null,
      // ⛔ 원천 문서 짝은 **둘 다 NULL** — 가리킬 문서가 없으면 둘을 함께 비운다(A-10).
      created_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
    },
  });

  // ⭐ LOT 코어 셋째 사용처. 코어가 무조건 거는 `INSPECTION_PENDING` + 수입검사 보류를
  //    **그대로 받는다** — 표식에 예외를 두지 않는다(`lot-registry.service.ts:93-97`).
  const lot = await lots.createWithin(
    tx,
    {
      lotNo: write.lotNo, itemId: input.itemId, lotTypeCode: MATERIAL_LOT_TYPE,
      plantId: write.plantId, initialQty: input.quantity, uomId: write.uomId,
      sourceTypeCode: SOURCE_DOCUMENT_TYPE, sourceId: Number(entry.recycle_entry_id),
    },
    actor.terminalAudit === undefined ? actor.appUserId as number
      : { workerId: actor.workerId, terminalAudit: actor.terminalAudit },
  );
  await tx.recycle_entry.update({
    where: { recycle_entry_id: entry.recycle_entry_id },
    data: { lot_id: lot.lot_id },
  });

  // ⛔ 재고를 바꾸는 유일한 길이다 — 도메인이 `inventory_balance` 를 직접 쓰지 않는다.
  await posting.post(tx, {
    // ⛔ 영업일은 클라이언트가 보낸 값이다(C-8). `occurredAt` 은 그것과 «다른» 축이다.
    businessDate: input.businessDate,
    occurredAt: new Date(input.occurredAt),
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    // 전표 번호를 그대로 원장 번호로 — 채번이 하나면 두 표를 사람이 맞대 볼 수 있다.
    transactionNo: write.recycleEntryNo,
    statusCode: POSTED,
    plantId: write.plantId,
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(entry.recycle_entry_id),
    // 헤더값이 아니라 «결정적» 키다 — 같은 등록을 다른 헤더 키로 보내도 원장이 하나다.
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${write.recycleEntryNo}`,
    createdBy: actor.appUserId,
    // ⛔ `from` 이 없다 — 그것이 「들어왔다」의 표현이다(원장은 유형 표를 두지 않는다).
    lines: [{
      itemId: input.itemId, lotId: Number(lot.lot_id), qty: input.quantity, uomId: write.uomId,
      to: {
        warehouseId: input.warehouseId, locationId: input.locationId,
        qualityStatusCode: LOT_QUALITY_STATUS, inventoryStatusCode: INVENTORY_AVAILABLE,
      },
      ownershipTypeCode: OWNERSHIP,
    }],
  });

  if (actor.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
    actor: actor.terminalAudit, targetTypeCode: 'RECYCLE_ENTRY',
    targetId: entry.recycle_entry_id, eventTypeCode: 'CREATE',
  });
  return entry.recycle_entry_id;
}
