import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/** 이력 한 줄의 종류 — 전달(의뢰 생성) · 결과 저장 · 결과 확정 · LOT 상태 전이. */
export type InspectionHistoryEventCode = 'REQUESTED' | 'RESULT_SAVED' | 'RESULT_CONFIRMED' | 'LOT_STATUS_CHANGED';

export interface InspectionHistoryEvent {
  occurredAt: string;
  eventTypeCode: InspectionHistoryEventCode;
  /** 누가 — 검사자(작업자 이름) 또는 계정 이름. 모르면 없다. */
  actorName?: string;
  inspectionResultNo?: string;
  inspectionRound?: number;
  overallJudgmentCode?: string;
  acceptedQty?: number;
  rejectedQty?: number;
  heldQty?: number;
  previousStatusCode?: string;
  newStatusCode?: string;
  transitionCode?: string;
  lotNo?: string;
}

export interface InspectionHistory {
  inspectionRequestId: number;
  inspectionRequestNo: string;
  inspectionTypeCode: string;
  /** 앞 단계가 넘긴 문서 — IQC 입하(LOT·입하 번호) · PQC 작업지시 · OQC 출하 지시. */
  source: { targetTypeCode: string; targetId: number; documentNo?: string; lotNo?: string };
  events: InspectionHistoryEvent[];
}

const INSPECTION_RESULT = 'INSPECTION_RESULT';

/**
 * 검사 대상 이력(omf-all-around#61 · 장부 P-55) — 한 검사 의뢰가 «어디서 넘어와» «어떻게 검사됐고» «LOT 이
 * 어떻게 움직였는지»를 시간순 한 줄로 낸다.
 *
 * ⭐ 새로 쌓지 않는다 — 이미 있는 셋(의뢰 · 회차 · LOT 상태 이력)을 엮는다. 그래서 이력이 문서와 갈리지 않는다.
 * ⛔ LOT 상태 이력은 «이 의뢰의 회차가 일으킨 것»만 담는다(원천 문서 = 검사 결과). 같은 LOT 의 다른 일(보류·처분)은
 *    LOT 현황(W-03-01)의 몫이다.
 */
@Injectable()
export class InspectionHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async history(inspectionRequestId: number): Promise<InspectionHistory> {
    const request = await this.prisma.inspection_request.findUnique({
      where: { inspection_request_id: BigInt(inspectionRequestId) },
      select: {
        inspection_request_id: true, inspection_request_no: true, inspection_type_code: true,
        target_type_code: true, target_id: true, requested_at: true,
        lot: { select: { lot_no: true, inbound_receipt_line: { select: { inbound_receipt: { select: { inbound_receipt_no: true } } }, take: 1 } } },
        work_order: { select: { work_order_no: true } },
        inspection_result: {
          orderBy: { inspection_round: 'asc' },
          select: {
            inspection_result_id: true, inspection_result_no: true, inspection_round: true, status_code: true,
            overall_judgment_code: true, accepted_qty: true, rejected_qty: true, held_qty: true,
            inspected_at: true, confirmed_at: true, worker: { select: { worker_name: true } },
          },
        },
      },
    });
    if (request === null) throw new NotFoundException('없는 검사 의뢰입니다.');

    const results = request.inspection_result;
    const lotEvents = results.length === 0 ? [] : await this.prisma.lot_status_event.findMany({
      where: {
        source_document_type_code: INSPECTION_RESULT,
        source_document_id: { in: results.map((row) => row.inspection_result_id) },
      },
      orderBy: { changed_at: 'asc' },
      select: {
        changed_at: true, previous_status_code: true, new_status_code: true, transition_code: true,
        lot: { select: { lot_no: true } }, app_user: { select: { user_name: true } },
        changed_worker: { select: { worker_name: true } },
      },
    });

    const events: InspectionHistoryEvent[] = [
      { occurredAt: request.requested_at.toISOString(), eventTypeCode: 'REQUESTED' } satisfies InspectionHistoryEvent,
      ...results.flatMap((row): InspectionHistoryEvent[] => {
        const base = {
          actorName: row.worker.worker_name,
          inspectionResultNo: row.inspection_result_no,
          inspectionRound: row.inspection_round,
          ...(row.overall_judgment_code === null ? {} : { overallJudgmentCode: row.overall_judgment_code }),
          acceptedQty: Number(row.accepted_qty),
          rejectedQty: Number(row.rejected_qty),
          heldQty: Number(row.held_qty),
        };
        const saved: InspectionHistoryEvent = { ...base, occurredAt: row.inspected_at.toISOString(), eventTypeCode: 'RESULT_SAVED' };
        return row.confirmed_at === null
          ? [saved]
          : [saved, { ...base, occurredAt: row.confirmed_at.toISOString(), eventTypeCode: 'RESULT_CONFIRMED' }];
      }),
      ...lotEvents.map((row): InspectionHistoryEvent => ({
        occurredAt: row.changed_at.toISOString(),
        eventTypeCode: 'LOT_STATUS_CHANGED',
        ...(row.previous_status_code === null ? {} : { previousStatusCode: row.previous_status_code }),
        newStatusCode: row.new_status_code,
        ...(row.transition_code === null ? {} : { transitionCode: row.transition_code }),
        lotNo: row.lot.lot_no,
        ...actorOf(row.changed_worker?.worker_name ?? row.app_user?.user_name),
      })),
    ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

    return {
      inspectionRequestId: Number(request.inspection_request_id),
      inspectionRequestNo: request.inspection_request_no,
      inspectionTypeCode: request.inspection_type_code,
      source: {
        targetTypeCode: request.target_type_code,
        targetId: Number(request.target_id),
        ...(await this.documentNoOf(request)),
        ...(request.lot === null ? {} : { lotNo: request.lot.lot_no }),
      },
      events,
    };
  }

  /** 넘어온 문서의 번호 — 대상 유형마다 자리가 다르다(A-10 다형 참조). 못 찾으면 비운다. */
  private async documentNoOf(request: {
    target_type_code: string;
    target_id: bigint;
    lot: { inbound_receipt_line: { inbound_receipt: { inbound_receipt_no: string } }[] } | null;
    work_order: { work_order_no: string } | null;
  }): Promise<{ documentNo?: string }> {
    const inbound = request.lot?.inbound_receipt_line[0]?.inbound_receipt.inbound_receipt_no;
    if (inbound !== undefined) return { documentNo: inbound };
    if (request.work_order !== null) return { documentNo: request.work_order.work_order_no };
    if (request.target_type_code === 'SHIPMENT_REQUEST') {
      const shipment = await this.prisma.shipment_request.findUnique({
        where: { shipment_request_id: request.target_id }, select: { shipment_request_no: true },
      });
      return shipment === null ? {} : { documentNo: shipment.shipment_request_no };
    }
    return {};
  }
}

function actorOf(name: string | undefined): { actorName?: string } {
  return name === undefined ? {} : { actorName: name };
}
