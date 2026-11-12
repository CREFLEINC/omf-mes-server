import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { recordInboundLotEvent } from './inbound-lot-event';
import { FinalizeBlockerCode, assertVersion, finalizeFactsOf, inboundLotFinalized } from './inbound-lot-finalizable';
import { InboundLotView, loadInboundLotViews } from './inbound-lot-view';

/** 계약 `InboundLotFinalize`. */
export interface InboundLotFinalize {
  versionNo: number;
  acknowledgeUnallocated?: boolean;
}

interface LockedForFinalize {
  status_code: string;
  erp_send_mode_code: string;
  version_no: number;
  inbound_receipt_line_id: bigint;
}

const FINALIZED = 'FINALIZED';
const RECEIVED = 'RECEIVED';
const NEW_FLOW = 'ON_FINALIZE';
const BLOCKER_MESSAGE: Record<FinalizeBlockerCode, string> = {
  IQC_IN_PROGRESS: 'IQC 가 진행 중인 자재 관리 LOT 이 있습니다',
  DISPOSITION_IN_PROGRESS: '부적합 처분이 진행 중인 자재 관리 LOT 이 있습니다',
  RECEIPT_CANCEL_PENDING: '입고 취소 요청 중인 자재 관리 LOT 이 있습니다',
  NOT_RECEIVED: '입고·처분으로 끝나지 않은 자재 관리 LOT 이 있습니다',
};

/**
 * 최종 마감(`:finalize` · R-24) — 「마감 승인 대기」일 때만 `FINALIZED`·최종 마감 사람·시각·이벤트 `RECEIPT_FINALIZED`.
 * ⛔ ERP 구매입고 묶음은 적재하지 않는다 — 최종 마감 때 적재는 #265 가 이 자리에 붙인다(R-25).
 */
@Injectable()
export class InboundLotFinalizeService {
  async finalize(tx: Prisma.TransactionClient, inboundLotId: number, body: InboundLotFinalize, appUserId: number): Promise<InboundLotView> {
    const id = BigInt(inboundLotId);
    const [locked] = await tx.$queryRaw<LockedForFinalize[]>`
      SELECT status_code, erp_send_mode_code, version_no, inbound_receipt_line_id
        FROM trace.inbound_lot WHERE inbound_lot_id = ${id} FOR UPDATE`;
    if (locked === undefined) throw new NotFoundException('없는 입하 LOT 입니다.');
    assertVersion(locked.version_no, body.versionNo);
    if (locked.erp_send_mode_code !== NEW_FLOW) {
      throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: 'LEGACY_INBOUND_LOT', message: '이전 데이터 입하 LOT 은 최종 마감하지 않습니다.' }]);
    }
    if (locked.status_code === FINALIZED) throw inboundLotFinalized();
    if (locked.status_code !== RECEIVED) {
      throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '입하 마감된 입하 LOT 만 최종 마감할 수 있습니다.' }]);
    }
    // 그 LOT 들의 입고를 잡는다 — 입고 취소 요청·실행(입고 `FOR UPDATE`)과 줄을 세워 판정이 낡지 않게 한다.
    await tx.$queryRaw`
      SELECT gr.goods_receipt_id
        FROM logistics.goods_receipt gr
       WHERE gr.goods_receipt_id IN (SELECT grl.goods_receipt_id FROM logistics.goods_receipt_line grl
                                       JOIN trace.lot l ON l.lot_id = grl.lot_id WHERE l.inbound_lot_id = ${id})
       ORDER BY gr.goods_receipt_id
         FOR SHARE`;
    const state = (await finalizeFactsOf(tx, [id])).get(id)?.state;
    if (state === undefined || !state.finalizable) {
      const blockers = state?.blockers ?? [];
      throw new ContractException(HttpStatus.CONFLICT, blockers.map((blocker) => ({
        scope: 'screen' as const, code: blocker.code, message: `${BLOCKER_MESSAGE[blocker.code]} — ${blocker.lotNos.join(', ')}`, lotNos: blocker.lotNos,
      })), { blockers });
    }
    const line = await tx.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: locked.inbound_receipt_line_id },
      select: { received_qty: true, inbound_receipt_po_allocation: { select: { purchase_order_line_id: true, allocated_qty: true } } },
    });
    const allocated = line.inbound_receipt_po_allocation.reduce((sum, row) => sum.plus(row.allocated_qty), new Prisma.Decimal(0));
    const unallocated = line.received_qty.minus(allocated);
    if (unallocated.greaterThan(0) && body.acknowledgeUnallocated !== true) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [{
        scope: 'screen', code: 'UNALLOCATED_REMAINS',
        message: `P/O 없음 ${unallocated.toString()} 이 남아 있습니다 — 그 수량은 ERP 로 가지 않습니다. 확인한 뒤 다시 최종 마감하세요.`,
      }], { details: { unallocatedQty: Number(unallocated) } });
    }

    const at = new Date();
    const by = BigInt(appUserId);
    await tx.inbound_lot.update({
      where: { inbound_lot_id: id },
      data: { status_code: FINALIZED, finalized_at: at, finalized_by: by, version_no: { increment: 1 }, updated_by: by },
    });
    await recordInboundLotEvent(tx, id, 'RECEIPT_FINALIZED', { appUserId }, {
      allocations: line.inbound_receipt_po_allocation.map((row) => ({ purchaseOrderLineId: String(row.purchase_order_line_id), qty: row.allocated_qty.toString() })),
      unallocatedQty: unallocated.toString(),
      acknowledgeUnallocated: body.acknowledgeUnallocated === true,
    }, at);
    const [view] = await loadInboundLotViews(tx, { inbound_lot_id: id });
    return view;
  }
}
