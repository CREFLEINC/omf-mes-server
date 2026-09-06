import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { day } from '../../common/master';

/**
 * LOT 계보 코어(`server-architecture.md` §1 `lot-genealogy`) — **값이 정해진 LOT 하나를
 * 호출자의 트랜잭션 안에 세우는 것**만 한다(채번·재시도·입력 검증은 호출자 몫). 사용처
 * 셋(`POST /trace/lots` · 입하 I-3 · 재생재 I-17)이 다 「라인과 LOT 이 한 트랜잭션」이다.
 */

/** 등록 즉시 거는 보류. 시드 `LOT_HOLD_REASON` 의 「수입검사 대기」다. */
export const INSPECTION_HOLD_REASON = 'INCOMING_INSPECTION_WAIT';
/**
 * ⚠ `LOT_HOLD_STATUS` 코드 그룹이 시드에 **없다** — 컬럼이 NOT NULL 이라 넣을 뿐이다.
 * ⛔ 해제 판정은 이 값이 아니라 **`released_at IS NULL`** 로만 한다(§Z-3).
 */
export const HOLD_STATUS = 'HELD';
/** 등록 시점의 품질 판정 — 검사 대기다(시드 `LOT_STATUS`). */
export const INITIAL_LOT_STATUS = 'INSPECTION_PENDING';
/** 이 원천만 역방향(라인 → LOT) 칸을 갖는다. */
const INBOUND_RECEIPT_LINE = 'INBOUND_RECEIPT_LINE';

export type Tx = Prisma.TransactionClient;
export type LotRow = Prisma.lotGetPayload<{ include: { lot_hold: true } }>;

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
}

@Injectable()
export class LotRegistryService {
  /**
   * ⛔ 읽기도 **전부 `tx`** 다 — `this.prisma` 로 읽으면 같은 트랜잭션이 방금 만든 입하 라인이 안 보인다.
   * 순서 불변식: **라인 → LOT → 라인 UPDATE** — `lot.source_id` 가 라인 id 라 라인이 먼저
   * 서고, `inbound_receipt_line.lot_id` 는 LOT 이 먼저 서야 채워진다.
   */
  async createWithin(tx: Tx, input: LotRegisterInput, appUserId: number): Promise<LotRow> {
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
        created_by: BigInt(appUserId),
      },
    });

    // ⭐ 화면이 보내지 않고 «서버가» 건다(MLOT #5).
    await tx.lot_hold.create({
      data: {
        lot_id: lot.lot_id,
        reason_code: INSPECTION_HOLD_REASON,
        status_code: HOLD_STATUS,
        held_by: BigInt(appUserId),
        held_at: new Date(),
      },
    });

    for (const identifier of input.externalIdentifiers ?? []) {
      await tx.lot_external_identifier.create({
        data: {
          lot_id: lot.lot_id,
          identifier_type_code: identifier.identifierTypeCode,
          external_identifier: identifier.externalIdentifier,
          partner_id: identifier.partnerId ?? null,
          external_system_code: identifier.externalSystemCode ?? null,
          created_by: BigInt(appUserId),
        },
      });
    }

    if (input.sourceTypeCode === INBOUND_RECEIPT_LINE) {
      await this.attach(tx, input.sourceId, lot.lot_id);
    }

    return tx.lot.findUniqueOrThrow({ where: { lot_id: lot.lot_id }, include: { lot_hold: true } });
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
