import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit, TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';
import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { ProductLotSplitQueryService } from './product-lot-split-query.service';
import type { ProductLotSplitView } from './product-lot-split-view';

/** 계약 `ProductLotSplitConfirm` — 스캔한 두 LOT, 순서 무관. */
export interface ProductLotSplitConfirmBody {
  lotIds?: number[];
}

export const ALREADY_CONFIRMED = 'ALREADY_CONFIRMED';

/**
 * PDA 분리 확인(M-04-05 · 피처 013 R-3) — 두 라벨이 그 분리의 원래·자식 짝이면 확인 시각·작업자·단말을 남긴다.
 * ⭐ LOT 상태와 무관하다 — 보류·불량이 된 뒤에도 확인한다(확인은 라벨 부착 확인일 뿐이다). 한 번 확인하면 되돌리지 않는다.
 */
@Injectable()
export class ProductLotSplitConfirmService {
  constructor(private readonly queries: ProductLotSplitQueryService) {}

  async confirmWithin(
    tx: Prisma.TransactionClient,
    splitId: number,
    body: ProductLotSplitConfirmBody,
    actor: TerminalWorkerAuditActor,
  ): Promise<ProductLotSplitView> {
    const [row] = await tx.$queryRaw<{ plant_id: bigint; parent_lot_id: bigint; child_lot_id: bigint; confirmed_at: Date | null }[]>`
      SELECT plant_id, parent_lot_id, child_lot_id, confirmed_at FROM trace.product_lot_split
       WHERE product_lot_split_id = ${splitId} FOR UPDATE`;
    if (row === undefined || row.plant_id !== actor.plantId) throw new NotFoundException('없는 분리입니다.');
    const scanned = new Set((body.lotIds ?? []).map((id) => String(id)));
    const pair = new Set([String(row.parent_lot_id), String(row.child_lot_id)]);
    if ((body.lotIds ?? []).length !== 2 || scanned.size !== 2 || [...scanned].some((id) => !pair.has(id))) {
      throw one(field('lotIds', ERROR_CODE.INVALID, '이 분리의 원래·새 LOT 라벨 두 장이 아닙니다.'));
    }
    if (row.confirmed_at !== null) {
      throw new ConflictException('user', `이미 확인된 분리입니다. (${row.confirmed_at.toISOString()})`, { code: ALREADY_CONFIRMED });
    }
    await tx.product_lot_split.update({
      where: { product_lot_split_id: BigInt(splitId) },
      data: {
        confirmed_at: new Date(), confirmed_worker_no: actor.workerNo, confirmed_terminal_id: actor.terminalId,
        updated_at: new Date(), version_no: { increment: 1 },
      },
    });
    await recordTerminalWorkerAudit(tx, { actor, targetTypeCode: 'PRODUCT_LOT_SPLIT', targetId: BigInt(splitId), eventTypeCode: 'CONFIRM' });
    return this.queries.view(tx, BigInt(splitId));
  }
}
