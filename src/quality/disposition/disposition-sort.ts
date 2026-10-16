import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LotQualityStatusService, splitLotWithin, Tx } from '../../core/lot';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';

/** 처분 «선별»(omf-all-around#108 · 장부 P-53). 양품은 정상, 불량분은 자식 LOT 으로 떼어 불량이다. */
export const SORT = 'SORT';

const SOURCE_TYPE = 'DISPOSITION_DECISION';
const POSTED = 'POSTED';
/** 떼어 낸 불량분의 다음 처분을 받을 부적합 — 판정 대기로 바로 연다(의뢰를 다시 거치지 않는다). */
const PENDING_DECISION = 'PENDING_DECISION';
const DEFECTIVE = 'DEFECTIVE';
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export interface SortQuantities {
  acceptedQty?: number;
  rejectedQty?: number;
  businessDate?: string;
}

export interface SortResult {
  splitLotId: number;
  splitLotNo: string;
  splitNonconformanceId: number;
  splitNonconformanceNo: string;
}

interface SortContext {
  nonconformanceId: bigint;
  decisionId: bigint;
  lotIds: bigint[];
  decisionQty: number;
  uomId: number;
  uomScale: number;
  reason: string;
  appUserId: number;
  decidedAt: Date;
  /** 트랜잭션 «밖»에서 미리 뽑은 부적합 번호 — 불량분이 있을 때만 쓴다(채번 코어 규약). */
  splitNonconformanceNo: string | null;
}

/** 본문 검사 — 트랜잭션 전에 부른다. 양품 + 불량 = 판정 수량, LOT 은 하나. */
export function assertSortShape(body: SortQuantities & { decisionQty: number }, lotCount: number, uomScale: number): void {
  const errors: ErrorItem[] = [];
  const accepted = body.acceptedQty;
  const rejected = body.rejectedQty;
  if (accepted === undefined || accepted < 0) errors.push(field('acceptedQty', ERROR_CODE.REQUIRED, '양품 수량이 필요합니다(0 이상).'));
  if (rejected === undefined || rejected < 0) errors.push(field('rejectedQty', ERROR_CODE.REQUIRED, '불량 수량이 필요합니다(0 이상).'));
  if (body.businessDate === undefined || !BUSINESS_DATE.test(body.businessDate)) {
    errors.push(field('businessDate', ERROR_CODE.REQUIRED, '업무 일자(YYYY-MM-DD)가 필요합니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  assertQtyPrecision('acceptedQty', accepted as number, uomScale);
  assertQtyPrecision('rejectedQty', rejected as number, uomScale);
  if (!new Prisma.Decimal(accepted as number).plus(rejected as number).equals(body.decisionQty)) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('rejectedQty', ERROR_CODE.INVALID, '양품 수량과 불량 수량의 합이 판정 수량과 같아야 합니다.'),
    ]);
  }
  // ⛔ 판정이 LOT 을 가리키지 않는다 — 여럿이면 어느 LOT 을 나눌지 정할 수 없다.
  if (lotCount !== 1) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '선별은 LOT 이 하나인 부적합만 할 수 있습니다.' },
    ]);
  }
}

/**
 * 선별 적용 — 처분 판정과 «같은 트랜잭션» 안에서 돈다.
 *
 * ① 불량분이 있으면 원 LOT 에서 자식 LOT 을 떼고(코어 `splitLotWithin`) ② 재고가 있으면 같은 위치에서
 * 원장으로 옮기고 ③ 자식을 불량(C24)으로 보내고 ④ 그 불량분으로 새 부적합(판정 대기)을 연다. 끝으로
 * ⑤ 원 LOT 을 정상(C23)으로 보낸다.
 *
 * ⭐ 불량분을 새 부적합으로 옮기는 이유 — 판정에는 LOT 칸이 없어 다음 처분(폐기 등)이 부적합의 «모든»
 *    LOT 을 옮긴다. 원 부적합에 자식을 붙이면 원 LOT(양품)까지 폐기된다.
 * ⛔ 재고가 여러 위치에 흩어진 LOT 은 거절한다 — 어느 위치의 수량을 뗄지 정할 축이 없다.
 */
@Injectable()
export class DispositionSortService {
  constructor(
    private readonly lots: LotQualityStatusService,
    private readonly posting: InventoryPostingService,
  ) {}

  async applyWithin(tx: Tx, body: SortQuantities, ctx: SortContext): Promise<SortResult | null> {
    const parentLotId = ctx.lotIds[0] as bigint;
    const rejected = new Prisma.Decimal(body.rejectedQty as number);
    const move = { changedBy: BigInt(ctx.appUserId), changedAt: ctx.decidedAt, sourceDocumentTypeCode: SOURCE_TYPE,
      sourceDocumentId: ctx.decisionId, reason: ctx.reason };

    let result: SortResult | null = null;
    if (rejected.greaterThan(0)) {
      const child = await splitLotWithin(tx, {
        parentLotId, qty: rejected, sourceEventTypeCode: SOURCE_TYPE, sourceEventId: ctx.decisionId,
        occurredAt: ctx.decidedAt, createdBy: BigInt(ctx.appUserId),
      });
      await this.moveStock(tx, parentLotId, child.lotId, rejected, body.businessDate as string, ctx);
      const moved = await this.lots.moveWithin(tx, [child.lotId], 'disposition-sort-defect', move);
      if (moved.movedLotIds.length === 0) throw stateLocked();
      const nc = await this.openSplitNonconformance(tx, child.lotId, rejected, ctx);
      result = {
        splitLotId: Number(child.lotId), splitLotNo: child.lotNo,
        splitNonconformanceId: Number(nc.nonconformance_id), splitNonconformanceNo: nc.nonconformance_no,
      };
    }
    const moved = await this.lots.moveWithin(tx, [parentLotId], 'disposition-sort', move);
    if (moved.movedLotIds.length === 0) throw stateLocked();
    return result;
  }

  private async moveStock(
    tx: Tx, parentLotId: bigint, childLotId: bigint, qty: Prisma.Decimal, businessDate: string, ctx: SortContext,
  ): Promise<void> {
    const balances = await tx.inventory_balance.findMany({
      where: { lot_id: parentLotId, on_hand_qty: { gt: 0 } },
      select: {
        item_id: true, plant_id: true, warehouse_id: true, location_id: true, quality_status_code: true,
        inventory_status_code: true, ownership_type_code: true, owner_partner_id: true, on_hand_qty: true,
      },
    });
    // 공정 중이라 아직 재고가 없는 LOT 은 LOT 기록만 나눈다.
    if (balances.length === 0) return;
    if (balances.length > 1) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '재고가 여러 위치에 있는 LOT 은 선별할 수 없습니다. 먼저 한 위치로 옮기세요.' },
      ]);
    }
    const balance = balances[0];
    if (balance.on_hand_qty.lessThan(qty)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('rejectedQty', ERROR_CODE.INVALID, `불량 수량이 LOT 의 재고(${balance.on_hand_qty.toString()})보다 많습니다.`),
      ]);
    }
    const endpoint = {
      warehouseId: Number(balance.warehouse_id), locationId: Number(balance.location_id),
      qualityStatusCode: balance.quality_status_code, inventoryStatusCode: balance.inventory_status_code,
    };
    const common = {
      itemId: Number(balance.item_id), qty: Number(qty), uomId: ctx.uomId,
      ownershipTypeCode: balance.ownership_type_code,
      ...(balance.owner_partner_id === null ? {} : { ownerPartnerId: Number(balance.owner_partner_id) }),
    };
    const transactionNo = `${SORT}-${ctx.decisionId.toString()}`;
    await this.posting.post(tx, {
      businessDate, occurredAt: ctx.decidedAt, transactionTypeCode: SOURCE_TYPE, transactionNo, statusCode: POSTED,
      plantId: Number(balance.plant_id), sourceDocumentTypeCode: SOURCE_TYPE, sourceDocumentId: Number(ctx.decisionId),
      idempotencyKey: `${SOURCE_TYPE}:${transactionNo}`, createdBy: ctx.appUserId,
      // 원 LOT 에서 빼고 자식 LOT 에 넣는다 — 같은 위치·같은 차원이라 위치 재고 합은 그대로다.
      lines: [
        { ...common, lotId: Number(parentLotId), from: endpoint },
        { ...common, lotId: Number(childLotId), to: endpoint },
      ],
    });
  }

  private async openSplitNonconformance(tx: Tx, childLotId: bigint, qty: Prisma.Decimal, ctx: SortContext) {
    const source = await tx.nonconformance.findUniqueOrThrow({
      where: { nonconformance_id: ctx.nonconformanceId },
      select: { nonconformance_no: true, item_id: true, work_order_id: true, inspection_result_id: true,
        severity_code: true, responsible_department_id: true },
    });
    const by = BigInt(ctx.appUserId);
    const created = await tx.nonconformance.create({
      data: {
        nonconformance_no: ctx.splitNonconformanceNo as string,
        item_id: source.item_id,
        work_order_id: source.work_order_id,
        inspection_result_id: source.inspection_result_id,
        severity_code: source.severity_code,
        description: `${source.nonconformance_no} 선별 불량분 — ${ctx.reason}`,
        responsible_department_id: source.responsible_department_id,
        status_code: PENDING_DECISION,
        opened_at: ctx.decidedAt,
        created_by: by,
        updated_by: by,
      },
      select: { nonconformance_id: true, nonconformance_no: true },
    });
    await tx.nonconformance_lot.create({
      data: {
        nonconformance_id: created.nonconformance_id, lot_id: childLotId, affected_qty: qty, uom_id: BigInt(ctx.uomId),
        quality_status_before_code: DEFECTIVE, quality_status_after_code: DEFECTIVE, created_by: by,
      },
    });
    return created;
  }
}

function stateLocked(): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '지금 LOT 상태에서는 선별로 옮길 수 없습니다.' },
  ]);
}
