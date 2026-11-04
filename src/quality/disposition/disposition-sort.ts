import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LotHoldService, LotQualityStatusService, splitLotWithin, Tx } from '../../core/lot';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';
import { releaseInspectionHoldsWithin } from './disposition-hold-release';

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

/** 원 LOT 에서 떼어 낼 불량분 — 선별과 특채 적용(omf-all-around#207)이 같이 쓴다. */
export interface SplitOffInput {
  nonconformanceId: bigint;
  /** 이 분할을 일으킨 처분 판정 — 계보·원장·새 부적합이 되짚는다. */
  decisionId: bigint;
  parentLotId: bigint;
  qty: Prisma.Decimal;
  uomId: number;
  /** 원장 영업일(C-8) — 원 LOT 에 재고가 있을 때만 쓴다. */
  businessDate: string | undefined;
  reason: string;
  /** 새 부적합 설명 머리 — 「선별 불량분」·「특채 후 불량으로 남은 수량」. */
  label: string;
  appUserId: number;
  decidedAt: Date;
  /** 트랜잭션 «밖»에서 미리 뽑은 부적합 번호(채번 코어 규약). */
  splitNonconformanceNo: string;
}

/** 본문 검사 — 채번·트랜잭션 «앞»에 부른다(400 이 될 저장에 번호를 태우지 않는다). 양품 + 불량 = 판정 수량. */
export function assertSortShape(body: SortQuantities & { decisionQty: number }): void {
  const errors: ErrorItem[] = [];
  const accepted = body.acceptedQty;
  const rejected = body.rejectedQty;
  if (accepted === undefined || accepted < 0) errors.push(field('acceptedQty', ERROR_CODE.REQUIRED, '양품 수량이 필요합니다(0 이상).'));
  if (rejected === undefined || rejected < 0) errors.push(field('rejectedQty', ERROR_CODE.REQUIRED, '불량 수량이 필요합니다(0 이상).'));
  if (body.businessDate === undefined || !BUSINESS_DATE.test(body.businessDate)) {
    errors.push(field('businessDate', ERROR_CODE.REQUIRED, '업무 일자(YYYY-MM-DD)가 필요합니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  if (!new Prisma.Decimal(accepted as number).plus(rejected as number).equals(body.decisionQty)) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('rejectedQty', ERROR_CODE.INVALID, '양품 수량과 불량 수량의 합이 판정 수량과 같아야 합니다.'),
    ]);
  }
}

/** 부적합을 읽은 뒤의 선별 검증 — 단위 소수 자리와 LOT 수. 트랜잭션 안에서 부른다. */
export function assertSortFitsTarget(body: SortQuantities, lotCount: number, uomScale: number): void {
  assertQtyPrecision('acceptedQty', body.acceptedQty as number, uomScale);
  assertQtyPrecision('rejectedQty', body.rejectedQty as number, uomScale);
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
    private readonly holds: LotHoldService,
  ) {}

  async applyWithin(tx: Tx, body: SortQuantities, ctx: SortContext): Promise<SortResult | null> {
    const parentLotId = ctx.lotIds[0] as bigint;
    const rejected = new Prisma.Decimal(body.rejectedQty as number);
    const move = { changedBy: BigInt(ctx.appUserId), changedAt: ctx.decidedAt, sourceDocumentTypeCode: SOURCE_TYPE,
      sourceDocumentId: ctx.decisionId, reason: ctx.reason };

    const result = rejected.greaterThan(0)
      ? await this.splitOffWithin(tx, {
        nonconformanceId: ctx.nonconformanceId, decisionId: ctx.decisionId, parentLotId, qty: rejected,
        uomId: ctx.uomId, businessDate: body.businessDate, reason: ctx.reason, label: '선별 불량분',
        appUserId: ctx.appUserId, decidedAt: ctx.decidedAt, splitNonconformanceNo: ctx.splitNonconformanceNo as string,
      })
      : null;
    const moved = await this.lots.moveWithin(tx, [parentLotId], 'disposition-sort', move);
    if (moved.movedLotIds.length === 0) throw stateLocked();
    // 양품분(원 LOT)이 정상이 됐다 — 수입검사 대기 보류도 닫는다(장부 P-63). 불량분 자식은 그대로다.
    await releaseInspectionHoldsWithin(tx, this.holds, moved.movedLotIds, { by: BigInt(ctx.appUserId), at: ctx.decidedAt });
    return result;
  }

  /**
   * 불량분 떼어 내기 — 자식 LOT(불량 C24) · 같은 위치 원장 이동 · 새 부적합(판정 대기). 원 LOT 의 상태는
   * 호출자가 정한다(선별은 정상 C23, 특채는 정상 C25).
   */
  async splitOffWithin(tx: Tx, input: SplitOffInput): Promise<SortResult> {
    const child = await splitLotWithin(tx, {
      parentLotId: input.parentLotId, qty: input.qty, sourceEventTypeCode: SOURCE_TYPE, sourceEventId: input.decisionId,
      occurredAt: input.decidedAt, createdBy: BigInt(input.appUserId),
    });
    await this.moveStock(tx, child.lotId, input);
    const moved = await this.lots.moveWithin(tx, [child.lotId], 'disposition-sort-defect', {
      changedBy: BigInt(input.appUserId), changedAt: input.decidedAt, sourceDocumentTypeCode: SOURCE_TYPE,
      sourceDocumentId: input.decisionId, reason: input.reason,
    });
    if (moved.movedLotIds.length === 0) throw stateLocked();
    const nc = await this.openSplitNonconformance(tx, child.lotId, input);
    return {
      splitLotId: Number(child.lotId), splitLotNo: child.lotNo,
      splitNonconformanceId: Number(nc.nonconformance_id), splitNonconformanceNo: nc.nonconformance_no,
    };
  }

  private async moveStock(tx: Tx, childLotId: bigint, input: SplitOffInput): Promise<void> {
    const { parentLotId, qty, businessDate } = input;
    const balances = await tx.inventory_balance.findMany({
      where: { lot_id: parentLotId, on_hand_qty: { gt: 0 } },
      select: {
        item_id: true, plant_id: true, warehouse_id: true, location_id: true, quality_status_code: true,
        inventory_status_code: true, ownership_type_code: true, owner_partner_id: true, on_hand_qty: true,
      },
    });
    // 공정 중·입고 전이라 아직 재고가 없는 LOT 은 LOT 기록만 나눈다.
    if (balances.length === 0) return;
    if (businessDate === undefined) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('businessDate', ERROR_CODE.REQUIRED, '재고가 있는 LOT 을 나누려면 업무 일자(YYYY-MM-DD)가 필요합니다.'),
      ]);
    }
    if (balances.length > 1) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '재고가 여러 위치에 있는 LOT 은 나눌 수 없습니다. 먼저 한 위치로 옮기세요.' },
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
      itemId: Number(balance.item_id), qty: Number(qty), uomId: input.uomId,
      ownershipTypeCode: balance.ownership_type_code,
      ...(balance.owner_partner_id === null ? {} : { ownerPartnerId: Number(balance.owner_partner_id) }),
    };
    const transactionNo = `${SORT}-${input.decisionId.toString()}`;
    await this.posting.post(tx, {
      businessDate, occurredAt: input.decidedAt, transactionTypeCode: SOURCE_TYPE, transactionNo, statusCode: POSTED,
      plantId: Number(balance.plant_id), sourceDocumentTypeCode: SOURCE_TYPE, sourceDocumentId: Number(input.decisionId),
      idempotencyKey: `${SOURCE_TYPE}:${transactionNo}`, createdBy: input.appUserId,
      // 원 LOT 에서 빼고 자식 LOT 에 넣는다 — 같은 위치·같은 차원이라 위치 재고 합은 그대로다.
      lines: [
        { ...common, lotId: Number(parentLotId), from: endpoint },
        { ...common, lotId: Number(childLotId), to: endpoint },
      ],
    });
  }

  private async openSplitNonconformance(tx: Tx, childLotId: bigint, input: SplitOffInput) {
    const source = await tx.nonconformance.findUniqueOrThrow({
      where: { nonconformance_id: input.nonconformanceId },
      select: { nonconformance_no: true, item_id: true, work_order_id: true, inspection_result_id: true,
        severity_code: true, responsible_department_id: true },
    });
    const by = BigInt(input.appUserId);
    const created = await tx.nonconformance.create({
      data: {
        nonconformance_no: input.splitNonconformanceNo,
        item_id: source.item_id,
        work_order_id: source.work_order_id,
        inspection_result_id: source.inspection_result_id,
        severity_code: source.severity_code,
        description: `${source.nonconformance_no} ${input.label} — ${input.reason}`,
        responsible_department_id: source.responsible_department_id,
        status_code: PENDING_DECISION,
        opened_at: input.decidedAt,
        created_by: by,
        updated_by: by,
      },
      select: { nonconformance_id: true, nonconformance_no: true },
    });
    await tx.nonconformance_lot.create({
      data: {
        nonconformance_id: created.nonconformance_id, lot_id: childLotId, affected_qty: input.qty, uom_id: BigInt(input.uomId),
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
