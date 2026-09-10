import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DOCUMENT_TYPES, LogisticsDocumentType } from './document-type-registry';

export type Tx = Prisma.TransactionClient | PrismaService;

/** `CD-CANCEL-BLOCKED-REASON` 5값 — 실행 오류 코드에서 «같은 문자열»을 가져온다(plan.md §5 규칙 6). */
export type CancelBlockedReason =
  | typeof ERROR_CODE.SUCCESSOR_EXISTS | typeof ERROR_CODE.ALREADY_CANCELLED
  | typeof ERROR_CODE.CANCEL_IN_PROGRESS | typeof ERROR_CODE.STATE_LOCKED | typeof ERROR_CODE.TYPE_NOT_CANCELABLE;

/** `CD-DOCUMENT-SUCCESSOR-TYPE` 5값. */
export type DocumentSuccessorType =
  | 'GOODS_RECEIPT' | 'GOODS_ISSUE' | 'PICKING_ORDER' | 'INVENTORY_TRANSACTION' | 'MATERIAL_CONSUMPTION';

/** 계약 `DocumentSuccessor`. `screenId` 는 채울 자료가 없어 영구 생략이다(I-5.md R-12 ⓢ). */
export interface DocumentSuccessorRow {
  successorTypeCode: DocumentSuccessorType;
  successorId: bigint;
  successorNo: string;
  qty: number;
}

export interface CancelEligibility {
  successorCount: number;
  /** 상세 GET 만 쓴다 — `withSuccessorRows` 없으면 빈 배열이다. */
  successors: DocumentSuccessorRow[];
  cancellable: boolean;
  cancelBlockedReasonCode?: CancelBlockedReason;
  cancelApprovalRequestId?: bigint;
  /** ⚠ 취소 경로가 없는 6종은 «대상 행을 안 읽어» 키가 없다 — 호출자가 자기 행에서 채운다(§4-4). */
  statusCode?: string;
}

const CANCELLED = 'CANCELLED';
const CANCEL_REQUESTED = 'CANCEL_REQUESTED';
/**
 * ⭐⭐ 자리 ⑤(I-23) — 출하가 «소유한» 출고·입고 전표의 원천 유형. 그 전표를 여기서 따로 취소하면
 * **출하는 살아 있는데 재고만 돌아온다**(원장은 소급 정정 불가). 취소는 출하의 `:cancel` 한 길뿐이다.
 * ⛔ 「후속」 축(`SUCCESSOR_EXISTS`)으로 막지 않는다 — 출하는 그 전표의 «상류»이고 후속 유형 enum 5값에
 *    `SHIPMENT` 가 없다. 세기만 하면 `successors:[]` 인데 `successorCount:1` 이라 화면이 보이지 않는
 *    후속을 먼저 취소하라고 안내한다. ⇒ 차단 사유 5값 안의 `STATE_LOCKED` 로 막는다(통보 217 ⓑ —
 *    「상류 문서가 소유한다」는 여섯째 값이 오면 안내가 정확해진다).
 */
const SHIPMENT_OWNER = 'SHIPMENT';
/** 취소를 받아 줄 수 있는 상태 — 시드 `LOGISTICS_DOCUMENT_STATUS` 4값 중 둘. */
const OPEN_STATUSES = ['REGISTERED', 'POSTED'];

// 계약이 5값의 우선순위를 안 줬다 — 싼 판정부터(§2 2단계 기준 5) · G-3 안내 순서와 같다(I-5.md §4-4)
const BLOCK_ORDER: readonly CancelBlockedReason[] = [ERROR_CODE.TYPE_NOT_CANCELABLE,
  ERROR_CODE.ALREADY_CANCELLED, ERROR_CODE.CANCEL_IN_PROGRESS, ERROR_CODE.STATE_LOCKED, ERROR_CODE.SUCCESSOR_EXISTS];

/**
 * 「이 문서가 만든 LOT」이 있는 유형. ⛔ `GOODS_ISSUE` 에는 LOT 축을 걸지 않는다 — 출고 라인의 LOT 은
 * 출고가 «만든» 것이 아니라 이미 있던 것이라, 세면 모든 출고가 영구히 취소 불가가 된다(I-5.md §4-2).
 */
const LOT_SOURCE_TYPES: readonly LogisticsDocumentType[] = ['INBOUND_RECEIPT', 'GOODS_RECEIPT'];

/** 문서 하류 세 표의 공통 조회 축 — `(source_document_type_code, source_document_id)`. */
type DownstreamWhere = { source_document_type_code: string; source_document_id: bigint; status_code?: { not: string } };

type SuccessorProbe = { count: number; rows: DocumentSuccessorRow[] };

/** 목록은 `successorCount` 만 쓰니 행이 필요 없으면 COUNT 로 끝낸다. */
async function branch<T>(withRows: boolean, count: () => Promise<number>, rows: () => Promise<T[]>, toRow: (found: T) => DocumentSuccessorRow): Promise<SuccessorProbe> {
  if (!withRows) return { count: await count(), rows: [] };
  const mapped = (await rows()).map(toRow);
  return { count: mapped.length, rows: mapped };
}

function row(successorTypeCode: DocumentSuccessorType, successorId: bigint, successorNo: string, qtys: Prisma.Decimal[]): DocumentSuccessorRow {
  return { successorTypeCode, successorId, successorNo, qty: qtys.reduce((s, q) => s + Number(q), 0) };
}

/**
 * 취소 판정 — 조회 2건과 `:request-cancel`·`:cancel` 이 «같은 함수»를 쓴다. 화면이 미리 본 것과
 * 실행 결과가 갈리면 그 화면이 틀린 안내를 한다(plan-api.md §5.1-B · I-5.md §4-1).
 *
 * ⛔ 다른 도메인의 service 를 부르지 않는다 — 열린 승인 요청은 `tx.approval_request` 를 직접 읽는다
 *    (다형 축 `ix_approval_request_target` · I-4.md R-4).
 */
@Injectable()
export class CancelEligibilityService {
  async evaluate(
    tx: Tx,
    typeCode: LogisticsDocumentType,
    documentId: bigint,
    opts?: { withSuccessorRows?: boolean },
  ): Promise<CancelEligibility> {
    const mapping = DOCUMENT_TYPES[typeCode];
    let statusCode: string | undefined;
    let cancelApprovalRequestId: bigint | undefined;
    let ownedByShipment = false;

    if (mapping.cancelable) {
      const document = await this.readDocument(tx, typeCode, documentId);
      // 행이 없으면 404 는 호출자가 «이 함수 앞에서» 낸다(§6-2 ③-1 · 계약은 상세 GET 에만 선언).
      statusCode = document?.status_code;
      ownedByShipment = document?.source_document_type_code === SHIPMENT_OWNER;
      // ⛔ 유형 접두가 필수다 — 없으면 다른 축의 승인이 취소 품의를 대신한다(I-5.md §6-2).
      const open = await tx.approval_request.findFirst({
        where: { target_type_code: mapping.entityTypeCode, target_id: documentId, approval_type_code: `${typeCode}_CANCEL`, status_code: 'PENDING' },
        select: { approval_request_id: true },
      });
      if (open !== null) cancelApprovalRequestId = open.approval_request_id;
    }

    // ⭐ successorCount 는 9종 전건 센다 — 순위 1 조기 종료는 cancellable·사유 코드에만 걸린다.
    //    「후속」 열은 취소 게이트가 아니라 진행현황 열이고 계약이 9종 required 로 뒀다(R-6 ⓐ).
    const found = await this.countSuccessors(tx, typeCode, documentId, opts?.withSuccessorRows === true);

    const hit: Record<CancelBlockedReason, boolean> = {
      TYPE_NOT_CANCELABLE: !mapping.cancelable,
      ALREADY_CANCELLED: statusCode === CANCELLED,
      // 상태가 CANCEL_REQUESTED 인데 반려돼 열린 요청이 없는 경우가 실재한다 — 그때도 막는다
      // (되돌릴 경로가 없어 잠긴 문서다 · I-5.md §4-4 · 문의 033).
      CANCEL_IN_PROGRESS: statusCode === CANCEL_REQUESTED || cancelApprovalRequestId !== undefined,
      STATE_LOCKED: (statusCode !== undefined && !OPEN_STATUSES.includes(statusCode)) || ownedByShipment,
      SUCCESSOR_EXISTS: found.count > 0,
    };
    const blocked = BLOCK_ORDER.find((code) => hit[code]);

    return {
      successorCount: found.count,
      successors: found.rows,
      cancellable: blocked === undefined,
      ...(blocked === undefined ? {} : { cancelBlockedReasonCode: blocked }),
      ...(cancelApprovalRequestId === undefined ? {} : { cancelApprovalRequestId }),
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  /** 취소 3종의 상태 한 칸. ⛔ 표 이름을 SQL 로 흘리지 않는다 — delegate 를 유형마다 부른다. */
  private async readDocument(
    tx: Tx,
    typeCode: LogisticsDocumentType,
    documentId: bigint,
  ): Promise<{ status_code: string; source_document_type_code?: string | null } | null> {
    // 원천 유형은 입고·출고만 갖는다 — 입하에는 그 칸이 없다(자리 ⑤ 는 두 유형을 덮는다).
    const select = { status_code: true };
    const withSource = { status_code: true, source_document_type_code: true };
    switch (typeCode) {
      case 'INBOUND_RECEIPT':
        return tx.inbound_receipt.findUnique({ where: { inbound_receipt_id: documentId }, select });
      case 'GOODS_RECEIPT':
        return tx.goods_receipt.findUnique({ where: { goods_receipt_id: documentId }, select: withSource });
      case 'GOODS_ISSUE':
        return tx.goods_issue.findUnique({ where: { goods_issue_id: documentId }, select: withSource });
      default:
        return null;
    }
  }

  /** 두 갈래 — 문서 하류 셋(9종 전건) + LOT 축 둘(입하·입고만). 가장 비싼 조회라 맨 뒤에 돈다. */
  private async countSuccessors(tx: Tx, typeCode: LogisticsDocumentType, documentId: bigint, withRows: boolean): Promise<SuccessorProbe> {
    const receiptWhere = this.downstream(typeCode, documentId, 'GOODS_RECEIPT');
    const issueWhere = this.downstream(typeCode, documentId, 'GOODS_ISSUE');
    const pickingWhere = this.downstream(typeCode, documentId, 'PICKING_ORDER');
    const probes = await Promise.all([
      branch(withRows, () => tx.goods_receipt.count({ where: receiptWhere }),
        () => tx.goods_receipt.findMany({ where: receiptWhere, select: { goods_receipt_id: true, goods_receipt_no: true, goods_receipt_line: { select: { receipt_qty: true } } } }),
        (r) => row('GOODS_RECEIPT', r.goods_receipt_id, r.goods_receipt_no, r.goods_receipt_line.map((l) => l.receipt_qty))),
      branch(withRows, () => tx.goods_issue.count({ where: issueWhere }),
        () => tx.goods_issue.findMany({ where: issueWhere, select: { goods_issue_id: true, goods_issue_no: true, goods_issue_line: { select: { issue_qty: true } } } }),
        (r) => row('GOODS_ISSUE', r.goods_issue_id, r.goods_issue_no, r.goods_issue_line.map((l) => l.issue_qty))),
      branch(withRows, () => tx.picking_order.count({ where: pickingWhere }),
        () => tx.picking_order.findMany({ where: pickingWhere, select: { picking_order_id: true, picking_order_no: true, picking_line: { select: { picked_qty: true } } } }),
        (r) => row('PICKING_ORDER', r.picking_order_id, r.picking_order_no, r.picking_line.map((l) => l.picked_qty))),
    ]);
    if (LOT_SOURCE_TYPES.includes(typeCode)) probes.push(...(await this.lotAxis(tx, typeCode, documentId, withRows)));
    return { count: probes.reduce((sum, p) => sum + p.count, 0), rows: probes.flatMap((p) => p.rows) };
  }

  /** 규칙 ② — 취소된 후속은 안 센다. 안 빼면 역순 취소가 영원히 안 풀린다(I-5.md §4-3). */
  private downstream(typeCode: LogisticsDocumentType, documentId: bigint, successor: LogisticsDocumentType): DownstreamWhere {
    const { cancelledStatus } = DOCUMENT_TYPES[successor];
    return {
      source_document_type_code: typeCode,
      source_document_id: documentId,
      ...(cancelledStatus === null ? {} : { status_code: { not: cancelledStatus } }),
    };
  }

  // INVENTORY_TRANSACTION 은 LOT 축이다 — 계약 문자(문서 하류)대로면 언제나 0 (I-5.md §4-2 · 문의 034)
  private async lotAxis(tx: Tx, typeCode: LogisticsDocumentType, documentId: bigint, withRows: boolean): Promise<SuccessorProbe[]> {
    const lotIds = await this.lotIds(tx, typeCode, documentId);
    if (lotIds.length === 0) return [];
    const ledgerWhere = {
      // 규칙 ③ — 역처리로 상쇄된 쌍은 둘 다 뺀다(역행 자신 · 되돌려진 원 행).
      reversal_of_transaction_id: null,
      reversed_by_transactions: { none: {} },
      // 규칙 ① — 자기 자신의 전기 원장은 후속이 아니다.
      NOT: { source_document_type_code: typeCode, source_document_id: documentId },
      inventory_transaction_line: { some: { lot_id: { in: lotIds } } },
    };
    const usedLots = { lot_id: { in: lotIds } };
    return Promise.all([
      branch(withRows, () => tx.inventory_transaction.count({ where: ledgerWhere }),
        () => tx.inventory_transaction.findMany({ where: ledgerWhere, select: { inventory_transaction_id: true, transaction_no: true, inventory_transaction_line: { where: usedLots, select: { qty: true } } } }),
        (r) => row('INVENTORY_TRANSACTION', r.inventory_transaction_id, r.transaction_no, r.inventory_transaction_line.map((l) => l.qty))),
      branch(withRows, () => tx.material_consumption.count({ where: usedLots }),
        () => tx.material_consumption.findMany({ where: usedLots, select: { material_consumption_id: true, consumption_no: true, input_qty: true } }),
        (r) => row('MATERIAL_CONSUMPTION', r.material_consumption_id, r.consumption_no, [r.input_qty])),
    ]);
  }

  /** 「이 문서가 만든 LOT」 — 입하는 라인의 `lot_id`(nullable), 입고는 라인의 `lot_id`(NOT NULL). */
  private async lotIds(tx: Tx, typeCode: LogisticsDocumentType, documentId: bigint): Promise<bigint[]> {
    if (typeCode === 'INBOUND_RECEIPT') {
      const lines = await tx.inbound_receipt_line.findMany({ where: { inbound_receipt_id: documentId }, select: { lot_id: true } });
      return lines.flatMap((l) => (l.lot_id === null ? [] : [l.lot_id]));
    }
    const lines = await tx.goods_receipt_line.findMany({ where: { goods_receipt_id: documentId }, select: { lot_id: true } });
    return lines.map((l) => l.lot_id);
  }
}
