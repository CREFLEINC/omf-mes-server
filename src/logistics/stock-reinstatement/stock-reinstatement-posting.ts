import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { InventoryPostingService } from '../../core/inventory-posting';
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { LockedLot, LotHoldService, LotQualityStatusService } from '../../core/lot';
import { assertWithinDecision, planHoldRelease } from './stock-reinstatement-rules';

/**
 * 재고 재등록 «한 트랜잭션» — 진입 판정 · 이동 문서 · 원장 · 보류 해제 · LOT 전이. HTTP 를 모른다.
 * 계약 「반출·도착·보류 해제·Lot Status 전이를 **한 트랜잭션**으로」(`W-04-11`).
 * ⛔ 창고 간 이동의 2단계 스캔(`:arrive`)을 쓰지 않는다 — 이동 중 구간이 없는 한 번의 행위다.
 * ⭐ 새 표를 세우지 않는다 — 응답이 `stockTransferId` 만 내리고 `reasonCode` 가 「만들어지는 이동 문서의
 *   `stock_transfer.reason_code` 에 실린다」라 적었다. 처분 결정은 PR ① 의 칸 하나로 잇는다(계획서 §2-3).
 */

type Tx = Prisma.TransactionClient;

const SOURCE_DOCUMENT_TYPE = 'STOCK_TRANSFER';
const POSTED = 'POSTED';
/** 시드 `STOCK_TRANSFER_TYPE` 2값 중 하나(실측) — ⛔ 새 코드값을 만들지 않는다(통보 222 ⓑ). */
const TRANSFER_TYPE = 'DEFECT_RETURN';
const NORMAL_DISPOSITION = 'NORMAL';
/** 특채 적용이 남기는 처분(omf-all-around#207) — 한도는 처분 수량이 아니라 특채 승인 수량이다. */
const CONCESSION_DISPOSITION = 'CONCESSION';
const APPLIED_CONCESSION = 'APPROVED';
const REINSTATE_ACTION = 'stock-reinstate';
const QUALITY_NORMAL = 'NORMAL';
const INVENTORY_AVAILABLE = 'AVAILABLE';

export interface StockReinstatementCreate {
  dispositionDecisionId: number;
  lot: { lotId: number; versionNo: number };
  /** 정상 처분이면 필수, 특채면 비운다 — 특채 적용이 수입검사 보류를 이미 닫았다(#207). */
  lotHoldId?: number | null;
  toWarehouseId: number;
  toLocationId?: number | null;
  qty: number;
  uomId: number;
  /** 정상 처분이면 필수(보류 해제 사유) — 특채는 닫을 보류가 없어 쓰지 않는다. */
  releaseReasonCode?: string | null;
  reasonCode?: string | null;
  businessDate: string;
  occurredAt: string;
  remarks?: string | null;
}

/** 계약 `StockReinstatementResponse` — required 9 + `remainingHeldQty`(널을 «받는» 칸). */
export interface StockReinstatementView {
  stockTransferId: number;
  stockTransferNo: string;
  lotId: number;
  lotStatusCode: string;
  /** 닫은 보류 — 특채는 닫을 보류가 없어 null 이다. */
  releasedLotHoldId: number | null;
  reinstatedQty: number;
  uomId: number;
  toWarehouseId: number;
  occurredAt: string;
  remainingHeldQty: number | null;
}

/** 도착 창고·위치 — 마스터라 서비스가 트랜잭션 밖에서 푼다. */
export interface ReinstatementTarget {
  warehouseId: number;
  plantId: bigint;
  businessUnitId: bigint;
  locationId: bigint;
}

export interface ReinstatementDeps {
  posting: InventoryPostingService;
  holds: LotHoldService;
  lots: LotQualityStatusService;
}

export interface ReinstatementWrite {
  body: StockReinstatementCreate;
  target: ReinstatementTarget;
  transferNo: string;
  appUserId: number;
}

interface DefectSource {
  warehouseId: bigint;
  locationId: bigint;
  plantId: bigint;
  businessUnitId: bigint;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  ownershipTypeCode: string;
  ownerPartnerId: bigint | null;
  available: Prisma.Decimal;
}

export async function postStockReinstatement(
  tx: Tx,
  deps: ReinstatementDeps,
  write: ReinstatementWrite,
): Promise<StockReinstatementView> {
  const { body, target, transferNo, appUserId } = write;
  const qty = new Prisma.Decimal(body.qty);
  const occurredAt = new Date(body.occurredAt);
  const actor = { by: BigInt(appUserId), at: occurredAt };

  // ① LOT 을 잠그고 토큰 대조 — 본문 `lot.versionNo`(If-Match 가 아니다 · 컬렉션 POST 라 헤더 원천이 없다).
  const [locked] = await deps.holds.lockLotsWithin(tx, [BigInt(body.lot.lotId)]);
  if (locked === undefined) throw badRequest('lot.lotId', ERROR_CODE.INVALID, '없는 LOT 입니다.');
  if (locked.version_no !== body.lot.versionNo) {
    assertUpdated(0, 'user', { code: 'VERSION_CONFLICT', currentVersion: String(locked.version_no) });
  }

  // ② 진입 판정 — 처분 결정 · LOT 이 그 결정에 속하나 · 처분 유형 · 한도 · 보류.
  // ⭐ 특채(#207)는 보류를 고르지 않는다 — 적용이 LOT 을 정상으로 올리고 수입검사 보류를 이미 닫았다(P-79).
  //    재고만 불량창고에 불량으로 남아 있어 그것을 정상 창고로 옮긴다.
  const disposition = await assertDecision(tx, body, locked, qty);
  const hold = disposition === CONCESSION_DISPOSITION ? noHoldFor(body) : await openHoldOf(tx, body, locked);

  // ③ 출발 잔액 — 본문에 `from*` 이 0개다. 그 LOT 의 «불량창고» 잔액 행이 정확히 하나여야 한다(§5-3).
  const lotRow = await tx.lot.findUniqueOrThrow({ where: { lot_id: locked.lot_id }, select: { item_id: true } });
  const source = await findDefectSource(tx, lotRow.item_id, locked.lot_id);
  if (source.available.lessThan(qty)) {
    throw badRequest('qty', ERROR_CODE.NEGATIVE_BALANCE, '불량창고에 남은 수량보다 많이 재등록할 수 없습니다.');
  }
  const plan = hold === null ? null : planHoldRelease(hold.hold_qty, qty, source.available);
  if (source.locationId === target.locationId) {
    // `ck_stock_transfer_locations(from <> to)` 을 앞당긴다 — DB 가 내면 500 이다.
    throw badRequest('toLocationId', ERROR_CODE.RANGE, '출발과 도착 위치가 같습니다.');
  }

  // ④ 이동 문서 한 건 — 반출·도착이 이 한 번에 끝나 `received_at` 이 채워진 채로 태어난다.
  const transfer = await tx.stock_transfer.create({
    data: {
      stock_transfer_no: transferNo,
      transfer_type_code: TRANSFER_TYPE,
      from_business_unit_id: source.businessUnitId,
      to_business_unit_id: target.businessUnitId,
      from_warehouse_id: source.warehouseId,
      to_warehouse_id: BigInt(target.warehouseId),
      requested_at: occurredAt,
      shipped_at: occurredAt,
      received_at: occurredAt,
      status_code: POSTED,
      reason_code: body.reasonCode ?? null,
      remarks: body.remarks ?? null,
      disposition_decision_id: BigInt(body.dispositionDecisionId),
      created_by: BigInt(appUserId),
      updated_by: BigInt(appUserId),
      stock_transfer_line: {
        create: [{
          line_no: 1,
          item_id: lotRow.item_id,
          lot_id: locked.lot_id,
          requested_qty: qty,
          shipped_qty: qty,
          received_qty: qty,
          uom_id: BigInt(body.uomId),
          from_location_id: source.locationId,
          to_location_id: target.locationId,
          created_by: BigInt(appUserId),
        }],
      },
    },
    select: { stock_transfer_id: true, stock_transfer_line: { select: { stock_transfer_line_id: true } } },
  });

  // ⑤ 원장 «한 건 · 라인 한 줄» — from 과 to 를 같은 줄에 싣는다 ⇒ IN_TRANSIT 가 아예 안 생긴다(§5-4).
  const posted = await deps.posting.post(tx, {
    // ⛔ 본문 영업일 그대로다(C-8).
    businessDate: body.businessDate,
    occurredAt,
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    transactionNo: transferNo,
    statusCode: POSTED,
    // 헤더에 plant 가 없다 — 출발 창고에서 푼다(`transfer-posting.ts:139` 와 같다).
    plantId: Number(source.plantId),
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(transfer.stock_transfer_id),
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${transferNo}`,
    createdBy: appUserId,
    lines: [{
      itemId: Number(lotRow.item_id),
      lotId: Number(locked.lot_id),
      qty: Number(qty),
      uomId: body.uomId,
      from: {
        warehouseId: Number(source.warehouseId),
        locationId: Number(source.locationId),
        qualityStatusCode: source.qualityStatusCode,
        inventoryStatusCode: source.inventoryStatusCode,
      },
      to: {
        warehouseId: target.warehouseId,
        locationId: Number(target.locationId),
        qualityStatusCode: QUALITY_NORMAL,
        inventoryStatusCode: INVENTORY_AVAILABLE,
      },
      ownershipTypeCode: source.ownershipTypeCode,
      ...(source.ownerPartnerId === null ? {} : { ownerPartnerId: Number(source.ownerPartnerId) }),
    }],
  });
  if (posted.alreadyPosted) {
    throw new Error(`재등록 원장이 이미 있다 — 번호가 유일한데 흡수됐다: ${transferNo}`);
  }
  const [ledgerLine] = await tx.inventory_transaction_line.findMany({
    where: { inventory_transaction_id: posted.inventoryTransactionId, business_date: new Date(`${body.businessDate}T00:00:00.000Z`) },
    select: { inventory_transaction_line_id: true },
  });
  // ⭐ 반출과 도착이 «같은 한 줄»이다 — 두 되짚기 칸에 같은 id(계약 「반출과 도착이 이 한 번에 끝났다」).
  await tx.stock_transfer_line.update({
    where: { stock_transfer_line_id: transfer.stock_transfer_line[0].stock_transfer_line_id },
    data: {
      issue_transaction_line_id: ledgerLine.inventory_transaction_line_id,
      receipt_transaction_line_id: ledgerLine.inventory_transaction_line_id,
    },
  });

  if (hold === null) {
    return viewOf(tx, { transfer, transferNo, lotId: locked.lot_id, holdId: null, openAfter: 0, body, qty, occurredAt });
  }
  const releaseReasonCode = body.releaseReasonCode as string;

  // ⑥ 보류 해제 + LOT 전이. ⭐⭐ **부분이면 옮기지 않는다**(R-4) — 코어가 잔량 행을 세워 openAfter ≥ 1.
  const others = await tx.lot_hold.count({
    where: { lot_id: locked.lot_id, released_at: null, lot_hold_id: { not: hold.lot_hold_id } },
  });
  const willMove = others === 0 && plan?.kind === 'full';
  const { openAfter } = await deps.holds.releaseWithin(
    tx,
    [locked],
    { lotId: locked.lot_id, lotHoldIds: [hold.lot_hold_id] },
    {
      releaseReasonCode,
      // ⭐ «실제로 보낸» 도착만 담는다 — 부분이면 안 움직여 비운다(lot-hold-write R-2 와 같다).
      ...(willMove ? { releaseTargetLotStatusCode: QUALITY_NORMAL } : {}),
      ...(plan?.kind === 'partial' ? { releaseQty: plan.releaseQty } : {}),
    },
    actor,
  );
  // 잠금 안이라 둘은 어긋날 수 없다 — 어긋나면 위 예측이 코어의 잔량 규칙과 갈린 것이다.
  if (willMove !== (openAfter === 0)) {
    throw new Error(`재등록 예측이 코어 재계수와 어긋났다: willMove=${willMove} openAfter=${openAfter}`);
  }
  if (openAfter === 0) {
    const { movedLotIds } = await deps.lots.moveWithin(tx, [locked.lot_id], REINSTATE_ACTION, {
      changedBy: actor.by,
      changedAt: actor.at,
      sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
      sourceDocumentId: transfer.stock_transfer_id,
      reasonCode: releaseReasonCode,
    });
    // ⛔ 코어는 `from` 밖이면 «던지지 않고 skip» 한다 — 그대로 두면 응답 lotStatusCode 가 조용히 거짓이다
    //    (자리 ②). 폐기된 LOT 을 판매 가능 재고로 되돌리는 것은 이 오퍼레이션이 아니다 ⇒ 409 로 되돌린다.
    if (movedLotIds.length === 0) {
      throw new ConflictException('user', '지금 LOT 상태에서는 재등록할 수 없습니다.', { code: 'INVALID_STATE' });
    }
  }

  return viewOf(tx, { transfer, transferNo, lotId: locked.lot_id, holdId: hold.lot_hold_id, openAfter, body, qty, occurredAt });
}

/** ⑦ 응답 — LOT 상태는 «다시 읽는다»(상수 NORMAL 로 고정하면 안 옮긴 부분 재등록이 거짓이 된다). */
async function viewOf(
  tx: Tx,
  done: {
    transfer: { stock_transfer_id: bigint }; transferNo: string; lotId: bigint; holdId: bigint | null; openAfter: number;
    body: StockReinstatementCreate; qty: Prisma.Decimal; occurredAt: Date;
  },
): Promise<StockReinstatementView> {
  const after = await tx.lot.findUniqueOrThrow({ where: { lot_id: done.lotId }, select: { status_code: true } });
  const remainder =
    done.openAfter === 0
      ? null
      : await tx.lot_hold.findFirst({
          where: { lot_id: done.lotId, released_at: null },
          orderBy: { lot_hold_id: 'desc' },
          select: { hold_qty: true },
        });
  return {
    stockTransferId: Number(done.transfer.stock_transfer_id),
    stockTransferNo: done.transferNo,
    lotId: Number(done.lotId),
    lotStatusCode: after.status_code,
    // ⛔ 닫은 행의 id 다 — 잔량 행이 아니다.
    releasedLotHoldId: done.holdId === null ? null : Number(done.holdId),
    reinstatedQty: Number(done.qty),
    uomId: done.body.uomId,
    toWarehouseId: done.body.toWarehouseId,
    occurredAt: done.occurredAt.toISOString(),
    remainingHeldQty: remainder?.hold_qty == null ? null : Number(remainder.hold_qty),
  };
}

/** 정상 처분 — 본문이 고른 «열린» 보류. 해제 사유도 이때만 필수다. */
async function openHoldOf(tx: Tx, body: StockReinstatementCreate, locked: LockedLot) {
  if (body.lotHoldId == null) throw badRequest('lotHoldId', ERROR_CODE.REQUIRED, '닫을 보류를 골라야 합니다.');
  if (body.releaseReasonCode == null) throw badRequest('releaseReasonCode', ERROR_CODE.REQUIRED, '보류 해제 사유가 필요합니다.');
  const hold = await tx.lot_hold.findUnique({ where: { lot_hold_id: BigInt(body.lotHoldId) } });
  if (hold === null || hold.lot_id !== locked.lot_id) {
    throw badRequest('lotHoldId', ERROR_CODE.INVALID, '이 LOT 의 보류가 아닙니다.');
  }
  if (hold.released_at !== null) {
    // ⭐ 다른 경로(판정 화면 W-03-02)가 먼저 풀었을 수 있다 — 계약이 이 코드로 적었다.
    throw new ConflictException('user', '보류가 이미 해제됐습니다.', { code: 'HOLD_ALREADY_RELEASED' });
  }
  return hold;
}

function noHoldFor(body: StockReinstatementCreate): null {
  if (body.lotHoldId != null) {
    throw badRequest('lotHoldId', ERROR_CODE.INVALID, '특채 재등록은 보류를 고르지 않습니다 — 특채 적용이 보류를 이미 닫았습니다.');
  }
  return null;
}

/**
 * 처분 결정 진입 판정 — ⓐ 결정이 있다 ⓑ LOT 이 그 부적합의 LOT 이다(`nonconformance_lot`) ⓒ 단위가 같다
 * ⓓ 처분이 NORMAL 이거나 CONCESSION 이다 ⓔ 누적 재등록이 한도 안이다. 처분 유형을 돌려준다.
 * ⛔ ⓑ 를 빼면 다른 결정의 LOT 을 이 결정 이름으로 풀 수 있다 — `nonconformance` 에는 `lot_id` 칸이 없다.
 * ⭐ 특채의 한도는 특채 승인 수량이다 — 일부 특채는 판정 수량이 남은 수량 «전체»다(나머지는 자식 LOT 으로 떼어 냄 · #207).
 *    특채 LOT 은 특채 기록의 LOT(원 LOT)뿐이다 — 떼어 낸 자식 LOT 은 원 부적합의 LOT 이 아니라 ⓑ 에서 걸린다.
 */
async function assertDecision(
  tx: Tx, body: StockReinstatementCreate, locked: LockedLot, qty: Prisma.Decimal,
): Promise<typeof NORMAL_DISPOSITION | typeof CONCESSION_DISPOSITION> {
  const decision = await tx.disposition_decision.findUnique({
    where: { disposition_decision_id: BigInt(body.dispositionDecisionId) },
    select: {
      disposition_type_code: true,
      decision_qty: true,
      uom_id: true,
      approval_request_id: true,
      nonconformance: { select: { nonconformance_lot: { select: { lot_id: true } } } },
    },
  });
  if (decision === null) throw badRequest('dispositionDecisionId', ERROR_CODE.INVALID, '없는 처분 결정입니다.');
  if (!decision.nonconformance.nonconformance_lot.some((row) => row.lot_id === locked.lot_id)) {
    throw badRequest('lot.lotId', ERROR_CODE.INVALID, '이 처분 결정의 LOT 이 아닙니다.');
  }
  if (decision.uom_id !== BigInt(body.uomId)) {
    throw badRequest('uomId', ERROR_CODE.INVALID, '처분 결정과 단위가 다릅니다.');
  }
  const disposition = decision.disposition_type_code;
  if (disposition !== NORMAL_DISPOSITION && disposition !== CONCESSION_DISPOSITION) throw notReinstatable();
  const limit = disposition === NORMAL_DISPOSITION
    ? decision.decision_qty
    : await concessionQtyOf(tx, decision.approval_request_id, locked.lot_id);
  const [sum] = await tx.$queryRaw<{ reinstated: Prisma.Decimal | null }[]>`
    SELECT sum(l.received_qty) AS reinstated
      FROM logistics.stock_transfer t
      JOIN logistics.stock_transfer_line l ON l.stock_transfer_id = t.stock_transfer_id
     WHERE t.disposition_decision_id = ${BigInt(body.dispositionDecisionId)}`;
  assertWithinDecision(sum?.reinstated ?? new Prisma.Decimal(0), limit, qty);
  return disposition;
}

/** 적용된 특채(이 결재 · 이 LOT)의 승인 수량. 없으면 이 LOT 은 특채로 되돌릴 수 없다. */
async function concessionQtyOf(tx: Tx, approvalRequestId: bigint | null, lotId: bigint): Promise<Prisma.Decimal> {
  const concession = approvalRequestId === null
    ? null
    : await tx.concession.findFirst({
        where: { approval_request_id: approvalRequestId, lot_id: lotId, status_code: APPLIED_CONCESSION },
        select: { approved_qty: true },
      });
  if (concession === null) throw notReinstatable();
  return concession.approved_qty;
}

const notReinstatable = (): ConflictException =>
  new ConflictException('user', '정상 처분이나 적용된 특채가 아닌 결정은 재등록할 수 없습니다.', {
    code: 'DISPOSITION_NOT_REINSTATABLE',
  });

/**
 * ⭐ 그 LOT 의 잔액 행 전건을 코어 순서로 잠그고(`lockBalancesByItemLot`) **불량창고**(`mdm.warehouse.is_defect`)
 * 행만 남긴다 — 「불량창고」를 코드군으로 찾지 않는다(통보 089 §8). 정확히 하나여야 한다.
 * 0행 → 409 `INVALID_STATE`(재고가 불량창고에 없다) · 2행+ → 400 `RANGE`(어느 것을 뺄지 정할 수 없다).
 */
async function findDefectSource(tx: Tx, itemId: bigint, lotId: bigint): Promise<DefectSource> {
  const rows = await lockBalancesByItemLot(tx, itemId, lotId);
  const warehouses = await tx.warehouse.findMany({
    where: { warehouse_id: { in: [...new Set(rows.map((row) => row.warehouseId))] } },
    select: { warehouse_id: true, is_defect: true, plant_id: true, business_unit_id: true },
  });
  const defect = new Map(warehouses.filter((w) => w.is_defect).map((w) => [w.warehouse_id.toString(), w]));
  const candidates = rows.filter((row) => defect.has(row.warehouseId.toString()));
  if (candidates.length === 0) {
    throw new ConflictException('user', '이 LOT 의 재고가 불량창고에 없습니다.', { code: 'INVALID_STATE' });
  }
  if (candidates.length > 1) {
    throw badRequest('lot.lotId', ERROR_CODE.RANGE, '불량창고 잔액이 둘 이상이라 어느 것을 되돌릴지 정할 수 없습니다.');
  }
  const row = candidates[0];
  const warehouse = defect.get(row.warehouseId.toString()) as (typeof warehouses)[number];
  if (row.available_qty === null) throw new Error(`available_qty 가 비어 있다: lot ${lotId}`);
  return {
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    plantId: warehouse.plant_id,
    businessUnitId: warehouse.business_unit_id,
    qualityStatusCode: row.quality_status_code,
    inventoryStatusCode: row.inventory_status_code,
    ownershipTypeCode: row.ownership_type_code,
    ownerPartnerId: row.owner_partner_id,
    available: row.available_qty,
  };
}

const badRequest = (path: string, code: string, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [field(path, code, message)]);
