import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** 계약 `InspectionConfirmCancelBlocker.code` — `INBOUND_LOT_FINALIZED` 는 최종 마감이 생기는 S12 가 낸다. */
export type ConfirmCancelBlockerCode = 'INBOUND_LOT_FINALIZED' | 'GOODS_RECEIVED' | 'DISPOSITION_STARTED' | 'CONCESSION_EXISTS' | 'LOT_STATUS_CHANGED';

export interface ConfirmCancelBlocker {
  scope: 'screen';
  code: ConfirmCancelBlockerCode;
  message: string;
  lotNos: string[];
}

/** 막힘마다 걸린 자재 관리 LOT 번호. 비면 그 막힘이 없다. */
export interface ConfirmCancelFacts {
  receivedLotNos: string[];
  dispositionLotNos: string[];
  concessionLotNos: string[];
  statusChangedLotNos: string[];
}

const MESSAGE: Record<Exclude<ConfirmCancelBlockerCode, 'INBOUND_LOT_FINALIZED'>, string> = {
  GOODS_RECEIVED: '입고된 자재 관리 LOT 이 있어 확정을 취소할 수 없습니다',
  DISPOSITION_STARTED: '부적합 처분 판정이 시작돼 확정을 취소할 수 없습니다',
  CONCESSION_EXISTS: '부적합에 특채가 있어 확정을 취소할 수 없습니다',
  LOT_STATUS_CHANGED: '확정 뒤 자재 관리 LOT 상태가 다른 이유로 바뀌어 확정을 취소할 수 없습니다',
};

/**
 * 판정 확정 취소를 막는 까닭(R-13 · plan 확인할 것 4) — 입고·처분·특채·IQC 밖 상태 변경이 확정 뒤에 쌓였으면 되돌리지 않는다.
 * 순서는 고정이고 LOT 번호는 번호 순·중복 없이.
 */
export function confirmCancelBlockers(facts: ConfirmCancelFacts): ConfirmCancelBlocker[] {
  const entries: [Exclude<ConfirmCancelBlockerCode, 'INBOUND_LOT_FINALIZED'>, string[]][] = [
    ['GOODS_RECEIVED', facts.receivedLotNos],
    ['DISPOSITION_STARTED', facts.dispositionLotNos],
    ['CONCESSION_EXISTS', facts.concessionLotNos],
    ['LOT_STATUS_CHANGED', facts.statusChangedLotNos],
  ];
  return entries
    .filter(([, lotNos]) => lotNos.length > 0)
    .map(([code, lotNos]) => {
      const sorted = [...new Set(lotNos)].sort();
      return { scope: 'screen' as const, code, message: `${MESSAGE[code]} — ${sorted.join(', ')}`, lotNos: sorted };
    });
}

/** 그 확정이 만든 부적합 — 확정 시각에 태어났고 아직 취소되지 않은 것. 앞 주기(재작업 재검사 전)의 부적합은 뺀다. */
export async function confirmMadeNonconformanceIds(tx: Tx, inspectionRequestId: bigint, confirmedAt: Date): Promise<bigint[]> {
  const rows = await tx.nonconformance.findMany({
    where: { inspection_request_id: inspectionRequestId, status_code: { not: 'CANCELLED' }, opened_at: { gte: confirmedAt } },
    select: { nonconformance_id: true },
    orderBy: { nonconformance_id: 'asc' },
  });
  return rows.map((row) => row.nonconformance_id);
}

export async function loadConfirmCancelFacts(
  tx: Tx,
  input: { inspectionRequestId: bigint; lots: readonly { lot_id: bigint; lot_no: string }[]; confirmedAt: Date; nonconformanceIds: bigint[] },
): Promise<ConfirmCancelFacts> {
  const lotIds = input.lots.map((lot) => lot.lot_id);
  const noOf = new Map(input.lots.map((lot) => [lot.lot_id, lot.lot_no]));
  const nos = (ids: Iterable<bigint>): string[] => [...ids].map((id) => noOf.get(id) ?? String(id));
  if (lotIds.length === 0) return { receivedLotNos: [], dispositionLotNos: [], concessionLotNos: [], statusChangedLotNos: [] };
  const ncIds = input.nonconformanceIds;
  const [received, decided, concessions, changed] = await Promise.all([
    tx.goods_receipt_line.findMany({
      where: { lot_id: { in: lotIds }, goods_receipt: { status_code: { not: 'CANCELLED' } } },
      select: { lot_id: true },
    }),
    ncIds.length === 0 ? [] : tx.nonconformance_lot.findMany({
      where: { nonconformance_id: { in: ncIds }, nonconformance: { disposition_decision: { some: {} } } },
      select: { lot_id: true },
    }),
    // 반려된 특채는 쓰이지 않으므로 막지 않는다.
    ncIds.length === 0 ? [] : tx.concession.findMany({
      where: { nonconformance_id: { in: ncIds }, status_code: { not: 'REJECTED' } },
      select: { lot_id: true },
    }),
    // 확정이 남긴 이력(원천 = 이 요청)과 같은 시각의 것도 그 밖이면 다른 사건이다.
    tx.lot_status_event.findMany({
      where: {
        lot_id: { in: lotIds },
        changed_at: { gte: input.confirmedAt },
        OR: [
          { source_document_type_code: null },
          { source_document_type_code: { not: 'INSPECTION_REQUEST' } },
          { source_document_id: { not: input.inspectionRequestId } },
        ],
      },
      select: { lot_id: true },
    }),
  ]);
  return {
    receivedLotNos: nos(new Set(received.map((row) => row.lot_id))),
    dispositionLotNos: nos(new Set(decided.map((row) => row.lot_id))),
    concessionLotNos: nos(new Set(concessions.map((row) => row.lot_id))),
    statusChangedLotNos: nos(new Set(changed.map((row) => row.lot_id))),
  };
}
