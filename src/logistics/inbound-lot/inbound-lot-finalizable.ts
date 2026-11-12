import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';

/** 최종 마감 막힘 코드(계약 `InboundLotFinalizeBlocker.code`) — 이 순서로 싣는다. */
export type FinalizeBlockerCode = 'IQC_IN_PROGRESS' | 'DISPOSITION_IN_PROGRESS' | 'RECEIPT_CANCEL_PENDING' | 'NOT_RECEIVED';

export interface FinalizeBlocker {
  code: FinalizeBlockerCode;
  lotNos: string[];
}

/** 자재 관리 LOT 하나의 「끝남」 재료. */
export interface LotFinalizeFacts {
  lotNo: string;
  /** 품질 상태(LOT_STATUS) — `SCRAPPED` 면 폐기 처분이 끝났다. */
  statusCode: string;
  /** 전기된(`POSTED`) 자재 입고가 이 LOT 을 덮는다. */
  posted: boolean;
  /** 이 LOT 을 담은 입고가 취소 요청 중(`CANCEL_REQUESTED`)이다. */
  cancelPending: boolean;
  /** 열린 부적합(판정 대기·처분 진행)에 담겼다. */
  inDisposition: boolean;
  /** 공급사 반품 출고(`SUPPLIER_RETURN`·`POSTED`)로 나갔다. */
  returned: boolean;
}

export interface InboundLotFinalizeInput {
  statusCode: string;
  erpSendModeCode: string;
  /** IQC 요청이 기록 중(`REQUESTED`·`IN_PROGRESS`)이다. */
  iqcOpen: boolean;
  lots: readonly LotFinalizeFacts[];
}

/** 계약 `InboundLot.lotProgress` — 자재 관리 LOT 수. */
export interface LotProgress {
  received: number;
  inIqc: number;
  inDisposition: number;
  disposed: number;
  returned: number;
}

export interface InboundLotFinalizeState {
  finalizable: boolean;
  /** 마감 승인 대기 판정 대상(`RECEIVED`·`ON_FINALIZE`)이 아니거나 막힘이 없으면 빈 배열. */
  blockers: FinalizeBlocker[];
  progress: LotProgress;
}

const RECEIVED = 'RECEIVED';
const FINALIZED = 'FINALIZED';
const NEW_FLOW = 'ON_FINALIZE';
const SCRAPPED = 'SCRAPPED';
const INSPECTION_PENDING = 'INSPECTION_PENDING';
const OPEN_IQC = ['REQUESTED', 'IN_PROGRESS'];
const CLOSED_NONCONFORMANCE = ['DECIDED', 'CANCELLED'];
const ORDER: readonly FinalizeBlockerCode[] = ['IQC_IN_PROGRESS', 'DISPOSITION_IN_PROGRESS', 'RECEIPT_CANCEL_PENDING', 'NOT_RECEIVED'];

/** LOT 이 「끝났나」 — 입고됐고 취소 요청 중이 아님, 또는 폐기·공급사 반품이 끝남(R-24). */
function finished(lot: LotFinalizeFacts): boolean {
  return (lot.posted && !lot.cancelPending) || lot.statusCode === SCRAPPED || lot.returned;
}

/**
 * 「마감 승인 대기」 판정(R-24 · data-model) — `RECEIVED`·`ON_FINALIZE` 이고 자재 관리 LOT 이 모두 끝났고, IQC 가 기록 중이 아니고,
 * 열린 부적합이 없다. 막힘은 LOT 마다 하나만 센다 — 취소 요청·처분이 먼저이고, 검사 대기 LOT 은 IQC 쪽으로 간다.
 */
export function finalizeStateOf(input: InboundLotFinalizeInput): InboundLotFinalizeState {
  const inIqc = input.iqcOpen ? input.lots.filter((lot) => lot.statusCode === INSPECTION_PENDING) : [];
  const progress: LotProgress = {
    received: input.lots.filter((lot) => lot.posted).length,
    inIqc: inIqc.length,
    inDisposition: input.lots.filter((lot) => lot.inDisposition).length,
    disposed: input.lots.filter((lot) => lot.statusCode === SCRAPPED).length,
    returned: input.lots.filter((lot) => lot.returned).length,
  };
  if (input.statusCode !== RECEIVED || input.erpSendModeCode !== NEW_FLOW) return { finalizable: false, blockers: [], progress };
  const found = new Map<FinalizeBlockerCode, string[]>();
  const add = (code: FinalizeBlockerCode, lotNo: string): void => {
    found.set(code, [...(found.get(code) ?? []), lotNo]);
  };
  if (input.iqcOpen) {
    for (const lot of inIqc.length > 0 ? inIqc : input.lots) add('IQC_IN_PROGRESS', lot.lotNo);
  }
  for (const lot of input.lots) {
    if (lot.inDisposition) add('DISPOSITION_IN_PROGRESS', lot.lotNo);
    else if (lot.cancelPending) add('RECEIPT_CANCEL_PENDING', lot.lotNo);
    else if (!finished(lot) && !(input.iqcOpen && lot.statusCode === INSPECTION_PENDING)) add('NOT_RECEIVED', lot.lotNo);
  }
  const blockers = ORDER.filter((code) => found.has(code)).map((code) => ({ code, lotNos: [...new Set(found.get(code))].sort() }));
  return { finalizable: blockers.length === 0 && input.lots.length > 0, blockers, progress };
}

export interface InboundLotFinalizeFacts {
  state: InboundLotFinalizeState;
  /** 자재 관리 LOT id(문자열) → 재료 — 상세 `lots[]` 의 입고 여부·처분 상태. */
  lots: Map<string, LotFinalizeFacts>;
}

interface LotRow {
  inbound_lot_id: bigint;
  lot_id: bigint;
  lot_no: string;
  status_code: string;
  posted: boolean;
  cancel_pending: boolean;
  in_disposition: boolean;
  returned: boolean;
}

/** 입하 LOT 마다 판정 — 자재 관리 LOT 재료를 한 문장으로 모아 읽는다(목록 N+1 없음). */
export async function finalizeFactsOf(db: Prisma.TransactionClient, inboundLotIds: bigint[]): Promise<Map<bigint, InboundLotFinalizeFacts>> {
  if (inboundLotIds.length === 0) return new Map();
  const [heads, rows, requests] = await Promise.all([
    db.inbound_lot.findMany({
      where: { inbound_lot_id: { in: inboundLotIds } }, select: { inbound_lot_id: true, status_code: true, erp_send_mode_code: true },
    }),
    db.$queryRaw<LotRow[]>`
      SELECT l.inbound_lot_id, l.lot_id, l.lot_no, l.status_code,
             EXISTS (SELECT 1 FROM logistics.goods_receipt_line grl
                       JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
                      WHERE grl.lot_id = l.lot_id AND gr.status_code = 'POSTED') AS posted,
             EXISTS (SELECT 1 FROM logistics.goods_receipt_line grl
                       JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
                      WHERE grl.lot_id = l.lot_id AND gr.status_code = 'CANCEL_REQUESTED') AS cancel_pending,
             EXISTS (SELECT 1 FROM quality.nonconformance_lot nl
                       JOIN quality.nonconformance n ON n.nonconformance_id = nl.nonconformance_id
                      WHERE nl.lot_id = l.lot_id AND n.status_code NOT IN (${Prisma.join(CLOSED_NONCONFORMANCE)})) AS in_disposition,
             EXISTS (SELECT 1 FROM logistics.goods_issue_line gil
                       JOIN logistics.goods_issue gi ON gi.goods_issue_id = gil.goods_issue_id
                      WHERE gil.lot_id = l.lot_id AND gi.issue_type_code = 'SUPPLIER_RETURN' AND gi.status_code = 'POSTED') AS returned
        FROM trace.lot l
       WHERE l.inbound_lot_id IN (${Prisma.join(inboundLotIds)})
       ORDER BY l.lot_no`,
    db.inspection_request.findMany({
      where: { inbound_lot_id: { in: inboundLotIds }, inspection_type_code: 'IQC', status_code: { in: OPEN_IQC } },
      select: { inbound_lot_id: true },
    }),
  ]);
  const iqcOpen = new Set(requests.map((row) => row.inbound_lot_id));
  const lotsOf = new Map<bigint, LotRow[]>();
  for (const row of rows) lotsOf.set(row.inbound_lot_id, [...(lotsOf.get(row.inbound_lot_id) ?? []), row]);
  return new Map(heads.map((head) => {
    const lots = (lotsOf.get(head.inbound_lot_id) ?? []).map((row) => ({
      lotId: row.lot_id, lotNo: row.lot_no, statusCode: row.status_code, posted: row.posted, cancelPending: row.cancel_pending,
      inDisposition: row.in_disposition, returned: row.returned,
    }));
    const state = finalizeStateOf({
      statusCode: head.status_code, erpSendModeCode: head.erp_send_mode_code, iqcOpen: iqcOpen.has(head.inbound_lot_id), lots,
    });
    return [head.inbound_lot_id, { state, lots: new Map(lots.map((lot) => [String(lot.lotId), lot])) }];
  }));
}

/** 「마감 승인 대기」 입하 LOT id — 목록 조건 `finalizable`. 후보(`RECEIVED`·`ON_FINALIZE`)만 판정한다. */
export async function finalizableIds(db: Prisma.TransactionClient, where: Prisma.inbound_lotWhereInput): Promise<bigint[]> {
  const candidates = await db.inbound_lot.findMany({
    where: { AND: [where, { status_code: RECEIVED, erp_send_mode_code: NEW_FLOW }] }, select: { inbound_lot_id: true },
  });
  const facts = await finalizeFactsOf(db, candidates.map((row) => row.inbound_lot_id));
  return [...facts].filter(([, fact]) => fact.state.finalizable).map(([id]) => id);
}

export const INBOUND_LOT_FINALIZED = 'INBOUND_LOT_FINALIZED';
const FINALIZED_MESSAGE = '최종 마감된 입하 LOT 입니다 — 바꿀 수 없습니다.';

export function inboundLotFinalized(lotNos: readonly string[] = []): ContractException {
  const suffix = lotNos.length > 0 ? ` (${lotNos.join(', ')})` : '';
  return new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: INBOUND_LOT_FINALIZED, message: `${FINALIZED_MESSAGE}${suffix}` }]);
}

/**
 * 최종 마감 뒤 불변(R-24) — 입하 LOT 을 바꾸는 경로가 부른다. 행을 `FOR SHARE` 로 잡아 동시 최종 마감과 줄을 세운다
 * (최종 마감은 `FOR UPDATE` — 먼저 잡은 쪽이 끝난 뒤 뒤쪽이 새 상태를 본다). `FINALIZED` 면 409 `INBOUND_LOT_FINALIZED`.
 */
export async function assertInboundLotMutable(tx: Prisma.TransactionClient, inboundLotId: bigint): Promise<void> {
  const [row] = await tx.$queryRaw<{ status_code: string }[]>`
    SELECT status_code FROM trace.inbound_lot WHERE inbound_lot_id = ${inboundLotId} FOR SHARE`;
  if (row === undefined) throw new NotFoundException('없는 입하 LOT 입니다.');
  if (row.status_code === FINALIZED) throw inboundLotFinalized();
}

/**
 * 자재 관리 LOT 들 중 최종 마감된 입하 LOT 소속인 것의 번호 — 입고 취소처럼 LOT 축으로 막는 경로가 쓴다. 잠그지 않는다 —
 * 최종 마감이 그 LOT 들의 입고를 `FOR SHARE` 로 잡으므로, 입고를 `FOR UPDATE` 로 잡은 취소와는 어느 쪽이든 뒤가 앞의 결과를 본다.
 */
export async function finalizedLotNosOf(db: Pick<Prisma.TransactionClient, 'lot'>, lotIds: readonly bigint[]): Promise<string[]> {
  if (lotIds.length === 0) return [];
  const rows = await db.lot.findMany({
    where: { lot_id: { in: [...lotIds] }, inbound_lot: { status_code: FINALIZED } }, select: { lot_no: true }, orderBy: { lot_no: 'asc' },
  });
  return rows.map((row) => row.lot_no);
}

/** W-01-16 쓰기(배정 수정·최종 마감)의 판 번호 — 다르면 409 `VERSION_CONFLICT`(동시 수정의 뒤쪽 · R23-1). */
export function assertVersion(current: number, sent: number): void {
  if (current !== sent) assertUpdated(0, 'user', { code: 'VERSION_CONFLICT', currentVersion: String(current) });
}
