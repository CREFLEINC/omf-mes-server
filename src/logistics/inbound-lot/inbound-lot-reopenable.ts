import { Prisma } from '@prisma/client';

/** 마감 취소를 막는 까닭 — 409 `errors[].code`(클라 C2 가 정한 값). */
export type ReopenBlockerCode =
  | 'IQC_RECORDED' | 'GOODS_RECEIVED' | 'SKIP_PENDING' | 'INBOUND_LOT_FINALIZED' | 'LEGACY_INBOUND_LOT' | 'OPEN_RECEIPT_EXISTS';

/** 마감 취소 가능 건의 까닭(C2 정함 — M-01-03 칩). */
export type ReopenReasonCode = 'NO_IQC_RESULT' | 'INSPECTION_NOT_REQUIRED' | 'IQC_SKIPPED';

export interface ReopenState {
  blockers: ReopenBlockerCode[];
  /** 막힌 것이 없을 때만 — 무엇을 되돌리는 마감 취소인가. */
  reasonCode: ReopenReasonCode | null;
  /** `OPEN_RECEIPT_EXISTS` 의 같은 조합 입하 중 입하 LOT 번호. */
  openInboundLotNo: string | null;
}

const CLOSED = ['RECEIVED', 'FINALIZED'];
const IQC_SKIP = 'IQC_SKIP';
const SKIP_TARGET = 'INBOUND_LOT';

/**
 * 마감(`RECEIVED`)·최종 마감 입하 LOT 마다 마감 취소 판정(data-model 「마감 취소 가능」 · R-5a). 그 밖 상태는 맵에 없다.
 * 다음 단계 전 = 검사 필요는 IQC 결과 0건·요청이 대기(REQUESTED)·생략 결재 대기 없음, 검사 불필요·긴급 생략 실행은 입고 0건.
 */
export async function reopenStatesOf(db: Prisma.TransactionClient, inboundLotIds: bigint[]): Promise<Map<bigint, ReopenState>> {
  if (inboundLotIds.length === 0) return new Map();
  const rows = await db.inbound_lot.findMany({
    where: { inbound_lot_id: { in: inboundLotIds }, status_code: { in: CLOSED } },
    select: {
      inbound_lot_id: true, plant_id: true, supplier_id: true, item_id: true, status_code: true, erp_send_mode_code: true,
      lot: { select: { lot_id: true } },
      inspection_request: {
        where: { inspection_type_code: 'IQC', status_code: { not: 'CANCELLED' } },
        orderBy: { inspection_request_id: 'desc' },
        select: { status_code: true, skip_basis_code: true, _count: { select: { inspection_result: true } } },
      },
    },
  });
  if (rows.length === 0) return new Map();
  const ids = rows.map((row) => row.inbound_lot_id);
  const lotIds = rows.flatMap((row) => row.lot.map((lot) => lot.lot_id));
  const [received, pending, open] = await Promise.all([
    db.$queryRaw<{ inbound_lot_id: bigint }[]>`
      SELECT DISTINCT l.inbound_lot_id
        FROM logistics.goods_receipt_line grl
        JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
        JOIN trace.lot l ON l.lot_id = grl.lot_id
       WHERE l.inbound_lot_id IN (${Prisma.join(ids)}) AND gr.status_code <> 'CANCELLED'`,
    // ⚠ 생략 결재의 대상은 아직 «LOT»이다(target_id = LOT id) — S10 이 입하 LOT id 로 옮기면 여기도 함께 바꾼다(data-model 이전 4).
    lotIds.length === 0 ? [] : db.approval_request.findMany({
      where: { approval_type_code: IQC_SKIP, target_type_code: SKIP_TARGET, status_code: 'PENDING', target_id: { in: lotIds } },
      select: { target_id: true },
    }),
    db.inbound_lot.findMany({
      where: { status_code: 'RECEIVING', OR: rows.map((row) => ({ plant_id: row.plant_id, supplier_id: row.supplier_id, item_id: row.item_id })) },
      select: { inbound_lot_no: true, plant_id: true, supplier_id: true, item_id: true },
    }),
  ]);
  const receivedIds = new Set(received.map((row) => row.inbound_lot_id));
  const pendingLots = new Set(pending.map((row) => row.target_id));
  const keyOf = (row: { plant_id: bigint; supplier_id: bigint; item_id: bigint }): string =>
    `${String(row.plant_id)}:${String(row.supplier_id)}:${String(row.item_id)}`;
  const openOf = new Map(open.map((row) => [keyOf(row), row.inbound_lot_no]));

  return new Map(rows.map((row) => {
    const request = row.inspection_request[0];
    const blockers: ReopenBlockerCode[] = [];
    if (row.status_code === 'FINALIZED') blockers.push('INBOUND_LOT_FINALIZED');
    if (row.erp_send_mode_code !== 'ON_FINALIZE') blockers.push('LEGACY_INBOUND_LOT');
    const iqcRecorded = request !== undefined && request.status_code !== 'SKIPPED'
      && (request.status_code !== 'REQUESTED' || request._count.inspection_result > 0);
    if (iqcRecorded) blockers.push('IQC_RECORDED');
    if (receivedIds.has(row.inbound_lot_id)) blockers.push('GOODS_RECEIVED');
    if (row.lot.some((lot) => pendingLots.has(lot.lot_id))) blockers.push('SKIP_PENDING');
    const openNo = openOf.get(keyOf(row)) ?? null;
    if (openNo !== null) blockers.push('OPEN_RECEIPT_EXISTS');
    return [row.inbound_lot_id, { blockers, reasonCode: blockers.length > 0 ? null : reasonOf(request), openInboundLotNo: openNo }];
  }));
}

function reasonOf(request: { status_code: string; skip_basis_code: string | null } | undefined): ReopenReasonCode {
  if (request?.status_code === 'REQUESTED') return 'NO_IQC_RESULT';
  if (request?.status_code === 'SKIPPED' && request.skip_basis_code === 'APPROVAL') return 'IQC_SKIPPED';
  return 'INSPECTION_NOT_REQUIRED';
}
