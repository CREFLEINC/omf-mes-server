import { Prisma } from '@prisma/client';

import { LotQualityStatusService } from '../../core/lot';
import { OQC, SHIPMENT_REQUEST_TARGET } from './oqc-lot-result';

/**
 * 출하 완료 때 그 지시서의 출하 OQC 를 한꺼번에 닫는다(피처 010 R-5 ③ · FR-012). 출하 완료 트랜잭션 안에서 부른다.
 * - 열린 의뢰(대기·진행): 작성중 결과 → 확정, 의뢰 → 완료(종합 판정·확정 시각). 관문이 이미 「모든 LOT 합격」을 확인했다.
 * - 피킹 LOT 이력: 확정한 의뢰의 품목 LOT 에 C4(합격 — 정상 → 정상), 생략된 의뢰의 품목 LOT 중 C27 이 없는 것(생략 뒤 피킹·교체)에 C27.
 * ⛔ 확정 서비스(`inspection-confirm.service.ts`)를 부르지 않는다 — 결과 단위 확정 효과(회차·부적합)가 새 흐름에 맞지 않는다.
 */
export interface OqcCompletionInput {
  shipmentRequestId: bigint;
  /** 출하되는 피킹 LOT — 검사 필요 라인만. */
  lots: { lotId: bigint; itemId: bigint }[];
  at: Date;
  actor: { changedBy: bigint } | { changedWorkerId: bigint };
}

const OPEN = ['REQUESTED', 'IN_PROGRESS'];
const SOURCE = 'INSPECTION_REQUEST';

export async function completeShipmentOqcWithin(
  tx: Prisma.TransactionClient,
  qualities: LotQualityStatusService,
  input: OqcCompletionInput,
): Promise<void> {
  const requests = await tx.inspection_request.findMany({
    where: {
      inspection_type_code: OQC, target_type_code: SHIPMENT_REQUEST_TARGET, lot_id: null,
      target_id: input.shipmentRequestId, status_code: { in: [...OPEN, 'SKIPPED'] },
    },
    select: { inspection_request_id: true, item_id: true, status_code: true },
    orderBy: { inspection_request_id: 'asc' },
  });
  const by = 'changedBy' in input.actor ? input.actor.changedBy : null;
  for (const request of requests) {
    const lotIds = [...new Set(input.lots.filter((lot) => lot.itemId === request.item_id).map((lot) => lot.lotId))];
    if (request.status_code === 'SKIPPED') {
      const marked = await tx.lot_status_event.findMany({
        where: { lot_id: { in: lotIds }, transition_code: 'C27' }, select: { lot_id: true },
      });
      const unmarked = lotIds.filter((lotId) => !marked.some((row) => row.lot_id === lotId));
      await qualities.moveWithin(tx, unmarked, 'oqc-skipped', {
        ...input.actor, changedAt: input.at, sourceDocumentTypeCode: SOURCE, sourceDocumentId: request.inspection_request_id,
      });
      continue;
    }
    await tx.inspection_result.updateMany({
      where: { inspection_request_id: request.inspection_request_id, status_code: 'DRAFT' },
      data: { status_code: 'CONFIRMED', confirmed_at: input.at, updated_by: by, version_no: { increment: 1 } },
    });
    await tx.inspection_request.update({
      where: { inspection_request_id: request.inspection_request_id },
      data: {
        status_code: 'COMPLETED', overall_judgment_code: 'ACCEPTED', confirmed_at: input.at, confirmed_by: by,
        updated_by: by, version_no: { increment: 1 },
      },
    });
    await qualities.moveWithin(tx, lotIds, 'inspection-accepted', {
      ...input.actor, changedAt: input.at, sourceDocumentTypeCode: SOURCE, sourceDocumentId: request.inspection_request_id,
    });
  }
}
