import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { day } from '../../common/master';
import { recordTerminalWorkerAudit, type TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';
import { LotHoldService } from './lot-hold.service';
import { materialMesLotNo, mesLotNo } from './lot-number';
import { WORK_ORDER_LOT_SOURCE } from './lot-source';

/**
 * LOT 계보 코어(`server-architecture.md` §1 `lot-genealogy`) — **값이 정해진 LOT 하나를
 * 호출자의 트랜잭션 안에 세우는 것**만 한다(채번·재시도·입력 검증은 호출자 몫). 사용처
 * 셋(`POST /trace/lots` · 입하 I-3 · 재생재 I-17)이 다 「라인과 LOT 이 한 트랜잭션」이다.
 */

/** 등록 즉시 거는 보류. 시드 `LOT_HOLD_REASON` 의 「수입검사 대기」다. */
export const INSPECTION_HOLD_REASON = 'INCOMING_INSPECTION_WAIT';
/** 등록 시점의 품질 판정 — 검사 대기다(시드 `LOT_STATUS`). */
export const INITIAL_LOT_STATUS = 'INSPECTION_PENDING';
/** 이 원천만 역방향(라인 → LOT) 칸을 갖는다. */
const INBOUND_RECEIPT_LINE = 'INBOUND_RECEIPT_LINE';
/** 선발행 슬롯의 생명주기 첫 상태 — 「예약」에 해당한다(시드 `LOT_LIFECYCLE_STATUS`). */
export const PREISSUED_LIFECYCLE = 'WAITING';
/** 선발행 슬롯의 유형(시드 `LOT_TYPE`). */
export const PRODUCTION_LOT_TYPE = 'PRODUCTION';

export type Tx = Prisma.TransactionClient;
export type LotRow = Prisma.lotGetPayload<{ include: { lot_hold: true } }>;
export type LotRegisterActor = number | { workerId: bigint; terminalAudit: TerminalWorkerAuditActor };

export interface ExternalIdentifierInput {
  identifierTypeCode: string;
  externalIdentifier: string;
  partnerId?: number | null;
  externalSystemCode?: string | null;
}

/** 코어가 받는 칸 — 계약 `LotCreate` 중 「LOT 자체의 값」만이다(번호는 이미 정해져 온다). */
export interface LotRegisterInput {
  lotNo: string;
  itemId: number;
  lotTypeCode: string;
  plantId: number;
  initialQty: number;
  uomId: number;
  manufacturedAt?: string | null;
  expiryDate?: string | null;
  sourceTypeCode: string;
  sourceId: number;
  remarks?: string | null;
  externalIdentifiers?: ExternalIdentifierInput[];
  incomingIqc?: {
    requestNo: string;
    effectiveDate: string;
    requestedAt: string;
  };
}

/** 선발행 슬롯 N 개가 받는 칸 — 번호·수량은 이미 정해져 온다(`nextMesLotNos`·`slotQtys`). */
export interface LotPreIssueInput {
  workOrderId: bigint;
  plantId: number;
  itemId: number;
  uomId: number;
  bomId: number | null;
  bomVersion: number | null;
  lotNos: string[];
  qtys: Prisma.Decimal[];
}

@Injectable()
export class LotRegistryService {
  constructor(private readonly holds: LotHoldService) {}

  /**
   * ⛔ 읽기도 **전부 `tx`** 다 — `this.prisma` 로 읽으면 같은 트랜잭션이 방금 만든 입하 라인이 안 보인다.
   * 순서 불변식: **라인 → LOT → 라인 UPDATE** — `lot.source_id` 가 라인 id 라 라인이 먼저
   * 서고, `inbound_receipt_line.lot_id` 는 LOT 이 먼저 서야 채워진다.
   */
  async createWithin(tx: Tx, input: LotRegisterInput, actor: LotRegisterActor): Promise<LotRow> {
    const appUserId = typeof actor === 'number' ? actor : undefined;
    const iqcPlanVersionId = input.incomingIqc
      ? await resolveIncomingIqcPlanVersion(tx, input.itemId, input.incomingIqc.effectiveDate)
      : undefined;
    const lot = await tx.lot.create({
      data: {
        lot_no: input.lotNo,
        item_id: input.itemId,
        lot_type_code: input.lotTypeCode,
        plant_id: input.plantId,
        initial_qty: input.initialQty,
        uom_id: input.uomId,
        source_type_code: input.sourceTypeCode,
        source_id: input.sourceId,
        status_code: INITIAL_LOT_STATUS,
        manufactured_at: optionalInstant(input.manufacturedAt),
        expiry_date: optionalDay(input.expiryDate),
        remarks: input.remarks ?? null,
        created_by: appUserId === undefined ? null : BigInt(appUserId),
      },
    });

    // ⭐ 화면이 보내지 않고 «서버가» 건다(MLOT #5).
    // ⚠ 방금 만든 행이라 **잠금 자체는 무동작**이다(아무도 못 보는 행이라 교착 사이클에 못 낀다).
    //    그래도 부르는 이유는 **표식에 예외를 두지 않으려는 것** — 예외를 내려면 `LockedLot` 발급
    //    경로가 하나 더 생기고 그러면 리뷰가 실측한 우회가 «권장 관용구»가 된다.
    //    비용: LOT 마다 왕복 1회(입하는 라인 수만큼).
    const locked = await this.holds.lockLotsWithin(tx, [lot.lot_id]);
    await this.holds.holdWithin(
      tx,
      locked,
      // `targetLotStatusCode` 는 이 보류가 LOT 을 «보낸» 곳 — 위 `lot.create` 와 같은 상수다(#351 G-5).
      [
        {
          lotId: lot.lot_id,
          reasonCode: INSPECTION_HOLD_REASON,
          targetLotStatusCode: INITIAL_LOT_STATUS,
        },
      ],
      typeof actor === 'number'
        ? { by: BigInt(actor), at: new Date() }
        : { workerId: actor.workerId, at: new Date() },
    );

    for (const identifier of input.externalIdentifiers ?? []) {
      await tx.lot_external_identifier.create({
        data: {
          lot_id: lot.lot_id,
          identifier_type_code: identifier.identifierTypeCode,
          external_identifier: identifier.externalIdentifier,
          partner_id: identifier.partnerId ?? null,
          external_system_code: identifier.externalSystemCode ?? null,
          created_by: appUserId === undefined ? null : BigInt(appUserId),
        },
      });
    }

    if (input.incomingIqc && iqcPlanVersionId !== undefined) {
      const request = await tx.inspection_request.create({
        data: {
          inspection_request_no: input.incomingIqc.requestNo,
          inspection_type_code: 'IQC',
          inspection_plan_version_id: iqcPlanVersionId,
          target_type_code: 'LOT',
          target_id: lot.lot_id,
          item_id: BigInt(input.itemId),
          lot_id: lot.lot_id,
          target_qty: input.initialQty,
          uom_id: BigInt(input.uomId),
          status_code: 'REQUESTED',
          requested_at: new Date(input.incomingIqc.requestedAt),
          created_by: appUserId === undefined ? null : BigInt(appUserId),
        },
      });
      if (typeof actor !== 'number') await recordTerminalWorkerAudit(tx, {
        actor: actor.terminalAudit, targetTypeCode: 'INSPECTION_REQUEST',
        targetId: request.inspection_request_id, eventTypeCode: 'CREATED',
      });
    }

    if (input.sourceTypeCode === INBOUND_RECEIPT_LINE) {
      await this.attach(tx, input.sourceId, lot.lot_id);
    }

    if (typeof actor !== 'number') await recordTerminalWorkerAudit(tx, {
      actor: actor.terminalAudit, targetTypeCode: 'LOT', targetId: lot.lot_id, eventTypeCode: 'CREATED',
    });

    return tx.lot.findUniqueOrThrow({
      where: { lot_id: lot.lot_id },
      include: { lot_hold: true },
    });
  }

  /**
   * W/O 확정배포의 **선발행 슬롯 N 개**. `createWithin` 의 자매 함수이지 확장이 아니다.
   *
   * ⛔ **`lot_hold` 를 걸지 않는다** — 실물이 없어 수입검사가 뜻이 안 맞고, 걸면
   *    `GET /trace/lots?heldOnly` 와 잔액의 `heldLotCount` 가 오염된다.
   * ⛔ **`lot_lifecycle_history` 를 쓰지 않는다** — `WAITING` 은 태어남이지 전이가 아니고
   *    `LOT_LIFECYCLE_TRANSITION` 에 「생성」 코드가 없다(값을 지어내지 않는다 · F-6).
   */
  async preIssueWithin(tx: Tx, input: LotPreIssueInput, appUserId: number): Promise<LotRow[]> {
    // 400 이 아니라 호출자 버그다 — 화면이 고칠 값이 아니다.
    if ((input.bomId === null) !== (input.bomVersion === null)) {
      throw new Error('bomId 와 bomVersion 은 둘 다 있거나 둘 다 없어야 한다 (ck_lot_bom_snapshot)');
    }
    if (input.lotNos.length !== input.qtys.length) throw new Error('lotNos 와 qtys 의 길이가 다르다');
    const lotIds: bigint[] = [];
    for (const [index, lotNo] of input.lotNos.entries()) {
      const lot = await tx.lot.create({
        data: {
          lot_no: lotNo,
          item_id: input.itemId,
          lot_type_code: PRODUCTION_LOT_TYPE,
          plant_id: input.plantId,
          initial_qty: input.qtys[index],
          uom_id: input.uomId,
          source_type_code: WORK_ORDER_LOT_SOURCE,
          source_id: input.workOrderId,
          status_code: INITIAL_LOT_STATUS,
          lifecycle_status_code: PREISSUED_LIFECYCLE,
          work_order_lot_seq: index + 1,
          bom_id: input.bomId,
          bom_version: input.bomVersion,
          created_by: BigInt(appUserId),
        },
      });
      lotIds.push(lot.lot_id);
    }

    return tx.lot.findMany({
      where: { lot_id: { in: lotIds } },
      include: { lot_hold: true },
      orderBy: { work_order_lot_seq: 'asc' },
    });
  }

  /** ⛔ `(source_type_code, source_id)` 유일 제약이 «없다» — 두 번 채우면 앞의 LOT 이 고아가
   *     되므로 `lot_id IS NULL` 인 행만 집는다. */
  private async attach(tx: Tx, sourceId: number, lotId: bigint): Promise<void> {
    const attached = await tx.inbound_receipt_line.updateMany({
      where: { inbound_receipt_line_id: sourceId, lot_id: null },
      data: { lot_id: lotId },
    });
    if (attached.count > 0) return;

    // 0행의 갈래가 둘이다. 판별을 «여기서만» 하는 것은 정상 경로에 읽기를 더하지 않으려는 것이다.
    const line = await tx.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: sourceId },
      select: { lot_id: true },
    });
    throw line === null
      ? one(field('sourceId', ERROR_CODE.INVALID, '없는 입하 라인입니다.'))
      : one(field('sourceId', ERROR_CODE.STATE_LOCKED, '이미 LOT 이 붙은 입하 라인입니다.'));
  }
}

async function resolveIncomingIqcPlanVersion(tx: Tx, itemId: number, effectiveDate: string): Promise<bigint> {
  const date = day('businessDate', effectiveDate);
  const plans = await tx.inspection_plan_version.findMany({
    where: {
      status_code: 'CONFIRMED',
      effective_from: { lte: date },
      OR: [{ effective_to: null }, { effective_to: { gte: date } }],
      inspection_plan: {
        item_id: itemId,
        inspection_type_code: 'IQC',
        is_active: true,
      },
    },
    select: { inspection_plan_version_id: true },
  });
  if (plans.length !== 1) {
    throw one({
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: plans.length === 0 ? '유효한 IQC 검사기준이 없습니다.' : '유효한 IQC 검사기준이 여러 개입니다.',
    });
  }
  return plans[0].inspection_plan_version_id;
}

// ── LOT 칸에 붙박인 값 변환(날짜는 타임존을 고르지 않는다) ──────────────────────────

export function optionalDay(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : day('expiryDate', value);
}

export function optionalInstant(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw one(field('manufacturedAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  return parsed;
}

/**
 * 지시수량을 LOT 크기로 나눈 슬롯 수량들 — 앞은 `lotSize`, 마지막만 나머지다.
 * ⛔ 부동소수로 세지 않는다 — 합이 지시수량과 «정확히» 같아야 한다(0.5/0.2).
 */
export function slotQtys(orderQty: Prisma.Decimal, lotSize: Prisma.Decimal): Prisma.Decimal[] {
  // 0 이하면 슬롯 수가 무한이 된다 — `ck_lot_initial_qty` 가 낼 500 을 400 으로 앞당긴다.
  if (lotSize.lessThanOrEqualTo(0)) {
    throw one(field('lotSize', ERROR_CODE.INVALID, 'LOT 크기는 0 보다 커야 합니다.'));
  }
  // ⌜lotSize 가 지시수량 이상이면 슬롯 1개⌝ — 수량은 lotSize 가 아니라 orderQty 다.
  if (lotSize.greaterThanOrEqualTo(orderQty)) return [orderQty];

  const slots = orderQty.dividedBy(lotSize).ceil().toNumber();
  const last = orderQty.minus(lotSize.times(slots - 1));
  return [...Array.from({ length: slots - 1 }, () => lotSize), last];
}

/**
 * 선발행 슬롯 N 개의 MES LOT 번호. ⛔ **`count` 를 한 번만 읽는다** — N 번 세면 같은
 * 트랜잭션 안이라 값이 안 변해 N 개가 모두 같은 순번을 얻는다.
 */
export async function nextMesLotNos(tx: Tx, plantId: number, businessDate: string, count: number): Promise<string[]> {
  const prefix = `M${String(plantId).padStart(6, '0').slice(-6)}${businessDate.replace(/-/g, '')}`;
  const used = await tx.lot.count({
    where: { plant_id: plantId, lot_no: { startsWith: prefix } },
  });
  return Array.from({ length: count }, (_, i) => mesLotNo(plantId, businessDate, used + 1 + i));
}

/**
 * 입하 자재만의 내부 MES LOT. 원천 행과 마스터에서 분절을 읽어, 외부 공급사 LOT 번호와
 * 절대 섞지 않는다. 충돌은 호출자가 `uq_lot` P2002만 골라 트랜잭션 전체를 재시도한다.
 */
export async function nextInboundMaterialLotNo(
  tx: Tx,
  input: {
    plantId: number;
    itemId: number;
    receivedQty: number;
    supplierId: number;
    businessDate: string;
  },
): Promise<string> {
  const [item, supplier] = await Promise.all([
    tx.item.findUnique({
      where: { item_id: input.itemId },
      select: { item_code: true },
    }),
    tx.partner.findUnique({
      where: { partner_id: input.supplierId },
      select: { partner_code: true },
    }),
  ]);
  if (!item) throw new Error('자재 MES LOT 대상 품목을 찾을 수 없습니다.');
  if (!supplier) throw new Error('자재 MES LOT 대상 공급사를 찾을 수 없습니다.');

  let prefix: string;
  try {
    // serial 이 마지막 4자리이므로, 앞 30자리만으로 같은 날 같은 입하 분절을 센다.
    prefix = materialMesLotNo({
      itemCode: item.item_code,
      qty: input.receivedQty,
      businessDate: input.businessDate,
      supplierCode: supplier.partner_code,
      serial: 1,
    }).slice(0, -4);
  } catch (error) {
    throw error instanceof Error ? one(field('lines', ERROR_CODE.INVALID, error.message)) : error;
  }
  // count+1은 중간 번호가 비었거나 외부 LOT가 같은 30자리 prefix를 쓴 경우에 충돌 값을
  // 되풀이한다. 실제 suffix 최댓값 다음을 쓰고, 동시 삽입의 유일 충돌만 호출자 재시도로 푼다.
  const existing = await tx.lot.findMany({
    where: { plant_id: input.plantId, lot_no: { startsWith: prefix } },
    select: { lot_no: true },
  });
  const serial = existing.reduce((max, lot) => {
    const suffix = lot.lot_no.slice(prefix.length);
    return /^\d{4}$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
  }, 0);
  try {
    return materialMesLotNo({
      itemCode: item.item_code,
      qty: input.receivedQty,
      businessDate: input.businessDate,
      supplierCode: supplier.partner_code,
      serial: serial + 1,
    });
  } catch (error) {
    throw error instanceof Error ? one(field('lines', ERROR_CODE.RANGE, error.message)) : error;
  }
}
