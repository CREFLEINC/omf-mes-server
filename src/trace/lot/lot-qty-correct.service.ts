import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertNotBlank } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { LotService } from './lot.service';
import { LotDetail } from './lot-view';
import { LotWriteActor } from './lot-write-actor';

export interface LotQtyCorrect {
  qty: number;
  reason: string;
}

export type LotQtyCorrection = LotDetail & { qtyBefore: number; labelReissueNeeded: boolean };

/** IQC 가 이 상태면 검사가 시작된 것이다 — 첫 임시 저장이 의뢰를 IN_PROGRESS 로 옮긴다(장부 P-106). */
const IQC_STARTED = ['IN_PROGRESS', 'COMPLETED', 'SKIPPED'];
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
/** 원 LOT 에서 갈라져 나온 LOT — 수량이 원 LOT·분할 기록과 묶여 있어 재고조정으로 맞춘다. */
const DERIVED_LOT_SOURCES = ['LOT_SPLIT', 'RECYCLE_ENTRY'];
const INBOUND_EDITABLE = 'REGISTERED';
const MATERIAL_LABELS = ['MATERIAL_LOT_LABEL', 'IQC_LABEL'];
const ADJUSTMENT = '재고조정(W-01-12)';

interface LockedLot {
  lot_no: string;
  source_type_code: string;
  source_id: bigint;
  initial_qty: Prisma.Decimal;
}

/**
 * 자재 LOT 수량 정정(장부 P-121). 입하로 들어온 자재 LOT 만, IQC 검사가 시작되기 전까지 — 입하 줄의 받은 수량과 LOT 수량을
 * 한 트랜잭션에서 같이 고친다(LOT 은 등록 때 입하 줄 수량과 같아야 했다). P/O 받은 수량은 배정 몫만 따라가므로 배정 합
 * 아래로는 줄이지 않는다.
 * ⭐ 잠금 순서는 IQC 의뢰 → LOT → 입하 헤더다 — IQC 저장이 의뢰를 먼저 잡고, 입하 줄 치환이 헤더를 먼저 잡는다.
 */
@Injectable()
export class LotQtyCorrectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lots: LotService,
  ) {}

  async correct(lotId: number, version: number, body: LotQtyCorrect, actor: LotWriteActor): Promise<{ detail: LotQtyCorrection; versionNo: number }> {
    assertNotBlank([['reason', body.reason]]);
    if (!(body.qty > 0)) throw one(field('qty', ERROR_CODE.RANGE, '수량은 0 보다 커야 합니다. 받은 수량을 다시 확인해 넣으세요.'));
    const { qtyBefore, labelReissueNeeded } = await this.prisma.$transaction((tx) => this.commit(tx, lotId, version, body, actor));
    const { detail, versionNo } = await this.lots.get(lotId);
    return { detail: { ...detail, qtyBefore, labelReissueNeeded }, versionNo };
  }

  private async commit(tx: Tx, lotId: number, version: number, body: LotQtyCorrect, actor: LotWriteActor) {
    const requests = await lockIqcRequests(tx, lotId);
    const lot = await lockLot(tx, lotId);
    assertInboundLot(lot);
    const qty = new Prisma.Decimal(body.qty);
    if (qty.equals(lot.initial_qty)) {
      throw one(field('qty', ERROR_CODE.INVALID, `바뀐 수량이 없습니다(지금 수량 ${lot.initial_qty.toString()}). 고칠 수량을 넣으세요.`));
    }
    await assertBeforeIqc(tx, requests, lot.lot_no);
    await assertNotReceived(tx, lotId, lot.lot_no);
    const inbound = await lockInboundLine(tx, lot.source_id);
    if (inbound === null) {
      throw locked(`이 LOT 의 입하 줄을 찾을 수 없어 수량을 고칠 수 없습니다(LOT ${lot.lot_no}). 수량 차이는 ${ADJUSTMENT}으로 맞추세요.`);
    }
    await assertInboundEditable(tx, inbound, qty, lot.lot_no);

    const updatedBy = actor.appUserId === undefined ? {} : { updated_by: BigInt(actor.appUserId) };
    const updated = await tx.lot.updateMany({
      where: { lot_id: lotId, version_no: version },
      data: { initial_qty: qty, version_no: { increment: 1 }, ...updatedBy },
    });
    assertUpdated(updated.count);
    // 헤더 버전을 올린다 — 열려 있던 입하 수정 화면이 옛 수량으로 줄을 다시 덮지 못하게.
    await tx.inbound_receipt.update({
      where: { inbound_receipt_id: inbound.inbound_receipt_id },
      data: { version_no: { increment: 1 }, ...updatedBy },
    });
    await tx.inbound_receipt_line.update({
      where: { inbound_receipt_line_id: inbound.inbound_receipt_line_id },
      data: { received_qty: qty, ...updatedBy },
    });
    // 아직 시작하지 않은 IQC 의뢰는 등록 때 LOT 수량을 검사 대상 수량으로 받았다 — 같이 따라간다.
    await tx.inspection_request.updateMany({
      where: { lot_id: BigInt(lotId), inspection_type_code: 'IQC', status_code: 'REQUESTED' },
      data: { target_qty: qty, version_no: { increment: 1 }, ...updatedBy },
    });
    const terminal = actor.terminalAudit;
    await tx.audit_event.create({ data: {
      occurred_at: new Date(),
      target_type_code: 'LOT',
      target_id: BigInt(lotId),
      event_type_code: 'LOT_QTY_CORRECTED',
      before_value: { qty: lot.initial_qty.toNumber(), inboundReceiptNo: inbound.inbound_receipt_no },
      after_value: { qty: body.qty, ...(terminal === undefined ? {} : { workerId: terminal.workerId.toString(), workerNo: terminal.workerNo }) },
      reason: body.reason.trim(),
      performed_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
      terminal_id: terminal?.terminalId ?? null,
      correlation_id: terminal?.correlationId ?? null,
    } });
    if (terminal !== undefined) await recordTerminalWorkerAudit(tx, { actor: terminal, targetTypeCode: 'LOT', targetId: BigInt(lotId) });
    // 출력 결과 칸이 생기기 전의 발행은 결과가 비어 있다 — 실패만 빼고 빈 것은 발행으로 센다.
    const labels = await tx.document_issue_log.findMany({
      where: { lot_id: BigInt(lotId), document_type_code: { in: MATERIAL_LABELS }, OR: [{ print_outcome_code: null }, { print_outcome_code: { not: 'FAILED' } }] },
      orderBy: [{ document_type_code: 'asc' }, { issue_seq: 'desc' }],
      distinct: ['document_type_code'],
      select: { label_qty: true },
    });
    // 라벨 종류마다 마지막 발행을 본다. 수량을 남기기 전 발행은 찍힌 수량을 몰라 — 수량이 늘 바뀌므로 — 다시 발행한다.
    const labelReissueNeeded = labels.some((row) => row.label_qty === null || !row.label_qty.equals(qty));
    return { qtyBefore: lot.initial_qty.toNumber(), labelReissueNeeded };
  }
}

interface IqcRequest {
  inspection_request_id: bigint;
  inspection_request_no: string;
  status_code: string;
}

/** 의뢰를 «먼저» 잠근다 — 첫 임시 저장이 같은 의뢰를 시작으로 옮기는 것과 엇갈리지 않게. */
async function lockIqcRequests(tx: Tx, lotId: number): Promise<IqcRequest[]> {
  return tx.$queryRaw<IqcRequest[]>`
    SELECT inspection_request_id, inspection_request_no, status_code FROM quality.inspection_request
     WHERE lot_id = ${BigInt(lotId)} AND inspection_type_code = 'IQC'
     ORDER BY inspection_request_id FOR UPDATE`;
}

async function lockLot(tx: Tx, lotId: number): Promise<LockedLot> {
  const rows = await tx.$queryRaw<LockedLot[]>`
    SELECT lot_no, source_type_code, source_id, initial_qty
      FROM trace.lot WHERE lot_id = ${BigInt(lotId)} FOR UPDATE`;
  if (rows.length === 0) {
    throw new ContractException(HttpStatus.NOT_FOUND, [{ scope: 'screen', code: 'NOT_FOUND', message: '없는 LOT 입니다. LOT 목록을 새로 고쳐 다시 고르세요.' }]);
  }
  return rows[0];
}

/** 입하로 들어온 자재 LOT 만 고친다 — 다른 원천은 수량이 다른 기록(실적·분할·재생)과 묶여 있다. */
function assertInboundLot(lot: LockedLot): void {
  if (lot.source_type_code === INBOUND_LOT_SOURCE) return;
  const message = lot.source_type_code === 'WORK_ORDER'
    ? `생산 LOT 의 수량은 여기서 고치지 않습니다(LOT ${lot.lot_no}). W/O 진행 상세의 실적 정정에서 고치세요.`
    : DERIVED_LOT_SOURCES.includes(lot.source_type_code)
      ? `선별 분할·재생으로 나온 LOT 이라 수량이 원 LOT 과 묶여 있습니다(LOT ${lot.lot_no}). 수량 차이는 ${ADJUSTMENT}으로 맞추세요.`
      : `입하로 들어온 자재 LOT 만 수량을 고칠 수 있습니다(LOT ${lot.lot_no}). 수량 차이는 ${ADJUSTMENT}으로 맞추세요.`;
  throw one(field('qty', ERROR_CODE.INVALID, message));
}

/** IQC 검사가 시작됐으면(첫 임시 저장부터, 회차 기록이 하나라도 있으면) 막는다 — 검사가 그 수량으로 샘플을 정했다. */
async function assertBeforeIqc(tx: Tx, requests: IqcRequest[], lotNo: string): Promise<void> {
  let started = requests.find((row) => IQC_STARTED.includes(row.status_code));
  if (started === undefined && requests.length > 0) {
    const recorded = await tx.inspection_result.findFirst({
      where: { inspection_request_id: { in: requests.map((row) => row.inspection_request_id) } },
      select: { inspection_request_id: true },
    });
    started = requests.find((row) => row.inspection_request_id === recorded?.inspection_request_id);
  }
  if (started === undefined) return;
  const what = started.status_code === 'SKIPPED' ? 'IQC 가 생략 처리된' : 'IQC 검사가 이미 시작된';
  throw locked(`${what} LOT 이라 수량을 고칠 수 없습니다(LOT ${lotNo} · IQC 의뢰 ${started.inspection_request_no} · IQC 수입검사·판정 화면에서 확인). 수량 차이는 입하 오류 등록(M-01-06)이나 공급사 반품 처리(W-01-05)로 처리하세요.`);
}

/**
 * 입고 전표(취소 제외)나 재고 원장에 그 LOT 이 있으면 막는다 — 잔액과 LOT 수량 중 어느 쪽이 참인지 알 수 없어진다.
 * 원장은 취소된 입고의 원·역 줄도 남으므로 한 번 입고했던 LOT 은 입고를 취소해도 막힌다(장부 P-121).
 */
async function assertNotReceived(tx: Tx, lotId: number, lotNo: string): Promise<void> {
  const receipt = await tx.goods_receipt_line.findFirst({
    where: { lot_id: BigInt(lotId), goods_receipt: { status_code: { not: 'CANCELLED' } } },
    select: { goods_receipt: { select: { goods_receipt_no: true } } },
  });
  const moved = receipt !== null || (await tx.inventory_transaction_line.findFirst({ where: { lot_id: BigInt(lotId) }, select: { inventory_transaction_line_id: true } })) !== null;
  if (!moved) return;
  const where = receipt === null ? `LOT ${lotNo}` : `LOT ${lotNo} · 입고 ${receipt.goods_receipt.goods_receipt_no}`;
  throw locked(`이미 재고에 반영된 LOT 이라 수량을 고칠 수 없습니다(${where} · 재고 현황·상태 조회 W-01-07 에서 확인). 수량 차이는 ${ADJUSTMENT}으로 맞추세요.`);
}

interface InboundLine {
  inbound_receipt_id: bigint;
  inbound_receipt_line_id: bigint;
  inbound_receipt_no: string;
  status_code: string;
}

/** 입하 헤더를 잠근다 — 입하 줄 치환이 헤더 버전 → 줄 순서로 쓰므로 같은 순서를 지켜야 교착하지 않는다. */
async function lockInboundLine(tx: Tx, inboundReceiptLineId: bigint): Promise<InboundLine | null> {
  const rows = await tx.$queryRaw<InboundLine[]>`
    SELECT ir.inbound_receipt_id, l.inbound_receipt_line_id, ir.inbound_receipt_no, ir.status_code
      FROM logistics.inbound_receipt_line l
      JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = l.inbound_receipt_id
     WHERE l.inbound_receipt_line_id = ${inboundReceiptLineId}
       FOR UPDATE OF ir`;
  return rows[0] ?? null;
}

/**
 * 입하 줄을 같이 고칠 수 있나 — 입하가 작성중이고, 차이·초과 연결·역참조 P/O 가 붙지 않았고(입하 줄 수정과 같은 잠금),
 * P/O 배정 합보다 작게 줄이지 않아야 한다(P/O 받은 수량은 배정 몫만 따라간다).
 */
async function assertInboundEditable(tx: Tx, line: InboundLine, qty: Prisma.Decimal, lotNo: string): Promise<void> {
  const at = `LOT ${lotNo} · 입하 ${line.inbound_receipt_no}`;
  if (line.status_code !== INBOUND_EDITABLE) {
    throw locked(`작성중이 아닌 입하의 LOT 이라 수량을 고칠 수 없습니다(${at}). 수량 차이는 입하 오류 등록(M-01-06)으로 처리하세요.`);
  }
  const where = { inbound_receipt_line_id: line.inbound_receipt_line_id };
  const successors =
    (await tx.inbound_variance.count({ where })) +
    (await tx.inbound_receipt_excess.count({ where: { ...where, purchase_order_line_id: { not: null } } })) +
    (await tx.purchase_order.count({ where: { source_inbound_receipt_line_id: line.inbound_receipt_line_id } }));
  if (successors > 0) {
    throw locked(`입하 줄에 차이 등록이나 초과분 P/O 가 이어져 있어 수량을 고칠 수 없습니다(${at}). 그 차이·초과 처리를 먼저 되돌리세요.`);
  }
  const allocated = await tx.inbound_receipt_po_allocation.aggregate({ where, _sum: { allocated_qty: true } });
  const sum = allocated._sum.allocated_qty ?? new Prisma.Decimal(0);
  if (qty.lessThan(sum)) {
    throw one(field('qty', ERROR_CODE.RANGE,
      `P/O 에 배정된 수량(${sum.toString()})보다 작게 줄일 수 없습니다(${at}). 초과 입하 분리(W-01-03)의 P/O 배정에서 배정을 먼저 줄이세요.`));
  }
}

function locked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
}
