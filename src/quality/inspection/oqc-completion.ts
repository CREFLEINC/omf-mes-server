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

/**
 * 송신 전 출하 취소 실행 때 그 지시서의 출하 OQC 를 다시 연다(2026-11-19 사용자 결정 · FR-023). 취소 트랜잭션 안에서 부른다.
 * - 완료(COMPLETED)된 새 흐름 의뢰 → 진행(IN_PROGRESS). 종합 판정·확정 시각·확정자를 비운다 — 다시 출하 완료할 때 채운다.
 * - 확정(CONFIRMED)된 결과는 그대로 둔다 — 그 LOT 의 판정 근거다(LOT 판정 = 순번 최대 매칭 결과, 상태와 무관 · data-model).
 *   다시 피킹한 새 LOT 의 결과는 작성중(DRAFT)으로 쌓이고, 다시 완료하면 확정된다(`completeShipmentOqcWithin`).
 * - 생략(SKIPPED) 의뢰는 그대로 — 생략은 결재로 정한 것이라 취소로 풀지 않는다.
 * - LOT 이력(C4·C27)은 되돌리지 않는다 — 정상 → 정상 기록이라 품질 상태가 바뀌지 않았다.
 */
export async function reopenShipmentOqcWithin(
  tx: Prisma.TransactionClient,
  input: { shipmentRequestId: bigint; actor: { changedBy: bigint } },
): Promise<number> {
  const reopened = await tx.inspection_request.updateMany({
    where: {
      inspection_type_code: OQC, target_type_code: SHIPMENT_REQUEST_TARGET, lot_id: null,
      target_id: input.shipmentRequestId, status_code: 'COMPLETED',
    },
    data: {
      status_code: 'IN_PROGRESS', overall_judgment_code: null, confirmed_at: null, confirmed_by: null,
      updated_by: input.actor.changedBy, version_no: { increment: 1 },
    },
  });
  return reopened.count;
}
