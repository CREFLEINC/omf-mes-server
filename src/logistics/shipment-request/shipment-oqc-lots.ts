import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';

/**
 * 출하작업지시 OQC 의 «대상 LOT» — 검사 대상 라인이 집은(피킹) LOT 집합(omf-all-around#119 · 2026-10-20 결정 D6-A·D6-b · 장부 P-83).
 *
 * ⭐ OQC 의뢰는 편성 때 품목별 «헤더 대상»(`lot_id` 없음)으로 선다 — LOT 은 피킹 때 처음 정해진다. 그래서 판정·생략의 LOT 이력은
 *    확정·실행 «시점»에 그 라인들의 예약에서 LOT 을 읽어 남긴다. 피킹이 덜 끝났으면 남길 LOT 이 모자라므로 400 이다(D6-b).
 * ⭐ 피킹 완료 = 라인의 `P = A` 이고 `A > 0` — 목록의 `pickingCompleteOnly` 와 같은 경계다(`shipment-progress.ts`).
 *    `P` 는 Σ(reserved − released)다(R-14).
 */

export interface OqcPickedLots {
  lotIds: bigint[];
  /** 피킹이 덜 끝난 검사 대상 라인 번호. 비어 있으면 다 끝났다. */
  unpickedLineNos: number[];
}

type Reader = Pick<Prisma.TransactionClient, 'shipment_request_line' | 'inventory_reservation'>;

/** `itemId` 를 주면 그 품목 라인만 본다 — OQC 의뢰가 품목별로 서서 확정은 자기 품목 라인의 LOT 만 옮긴다. */
export async function oqcPickedLots(
  prisma: Reader,
  shipmentRequestId: bigint,
  itemId: bigint | null,
): Promise<OqcPickedLots> {
  const lines = await prisma.shipment_request_line.findMany({
    where: {
      shipment_request_id: shipmentRequestId,
      shipping_inspection_required: true,
      ...(itemId === null ? {} : { item_id: itemId }),
    },
    select: { shipment_request_line_id: true, line_no: true, allocated_qty: true },
    orderBy: { line_no: 'asc' },
  });
  if (lines.length === 0) return { lotIds: [], unpickedLineNos: [] };

  const reservations = await prisma.inventory_reservation.findMany({
    where: {
      source_document_type_code: SHIPMENT_REQUEST_LINE,
      source_document_id: { in: lines.map((line) => line.shipment_request_line_id) },
    },
    select: { source_document_id: true, lot_id: true, reserved_qty: true, released_qty: true },
  });

  const pickedByLine = new Map<string, Prisma.Decimal>();
  const lotIds = new Map<string, bigint>();
  for (const row of reservations) {
    const remaining = new Prisma.Decimal(row.reserved_qty).minus(row.released_qty);
    const key = String(row.source_document_id);
    pickedByLine.set(key, (pickedByLine.get(key) ?? new Prisma.Decimal(0)).plus(remaining));
    if (row.lot_id !== null && remaining.greaterThan(0)) lotIds.set(String(row.lot_id), row.lot_id);
  }

  const unpickedLineNos = lines
    .filter((line) => {
      const allocated = new Prisma.Decimal(line.allocated_qty);
      const picked = pickedByLine.get(String(line.shipment_request_line_id)) ?? new Prisma.Decimal(0);
      return !(allocated.greaterThan(0) && picked.equals(allocated));
    })
    .map((line) => line.line_no);

  return { lotIds: [...lotIds.values()], unpickedLineNos };
}

/** 피킹이 덜 끝났으면 400 — 어느 라인인지 문구에 싣는다. `action` 은 문구의 끝(「판정하세요」·「생략을 실행하세요」)이다. */
export function assertOqcPicked(picked: OqcPickedLots, action: '판정하세요' | '생략을 실행하세요'): void {
  if (picked.unpickedLineNos.length === 0) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: `라인 ${picked.unpickedLineNos.join('·')} 의 피킹이 끝나지 않았습니다. 피킹을 마친 뒤 ${action}.`,
    },
  ]);
}

/**
 * 출하검사가 끝난(판정 확정·생략) 지시의 «검사 때 대상이던» LOT — 끝난 시각까지 검사 대상 라인이 집은 예약의 LOT 이다(장부 P-126).
 * 반납 뒤 다시 집은 LOT 이 여기 없으면 화면에 알린다(막지는 않는다). 끝나지 않았으면 null.
 */
export async function oqcSettledLots(
  prisma: Pick<Prisma.TransactionClient, 'inspection_result' | 'inspection_request' | 'inventory_reservation' | 'shipment_request_line'>,
  shipmentRequestId: bigint,
): Promise<Set<string> | null> {
  const header = { inspection_type_code: 'OQC', target_type_code: 'SHIPMENT_REQUEST', target_id: shipmentRequestId };
  const [judged, skipped] = await Promise.all([
    prisma.inspection_result.aggregate({ where: { status_code: 'CONFIRMED', inspection_request: header }, _max: { confirmed_at: true, updated_at: true } }),
    prisma.inspection_request.aggregate({ where: { ...header, status_code: 'SKIPPED' }, _max: { updated_at: true } }),
  ]);
  const times = [judged._max.confirmed_at ?? judged._max.updated_at, skipped._max.updated_at].filter((at): at is Date => at !== null);
  if (times.length === 0) return null;
  const settledAt = new Date(Math.max(...times.map((at) => at.getTime())));
  const rows = await prisma.inventory_reservation.findMany({
    where: {
      source_document_type_code: SHIPMENT_REQUEST_LINE, created_at: { lte: settledAt },
      source_document_id: { in: await linesNeedingOqc(prisma, shipmentRequestId) },
    },
    select: { lot_id: true },
  });
  return new Set(rows.flatMap((row) => (row.lot_id === null ? [] : [String(row.lot_id)])));
}

async function linesNeedingOqc(prisma: Pick<Prisma.TransactionClient, 'shipment_request_line'>, shipmentRequestId: bigint): Promise<bigint[]> {
  const lines = await prisma.shipment_request_line.findMany({
    where: { shipment_request_id: shipmentRequestId, shipping_inspection_required: true },
    select: { shipment_request_line_id: true },
  });
  return lines.map((line) => line.shipment_request_line_id);
}
