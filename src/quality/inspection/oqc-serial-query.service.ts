import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TerminalQualityReadScope, terminalInspectionRequestWhere } from '../../auth/terminal-quality-read-scope';
import { omitEmpty } from '../../common/http/omit-empty';
import { SHIPMENT_REQUEST_LINE } from '../../logistics/shipment-request/shipment-progress';
import { PrismaService } from '../../prisma/prisma.service';

/** 생략(`SKIPPED`)만 뺀다 — 완료된 의뢰도 재검 회차에서 같은 시리얼을 다시 찍는다(Q4). */
const REQUEST_STATUS_CODES = ['REQUESTED', 'IN_PROGRESS', 'COMPLETED'];

/**
 * 시리얼 OQC 조회 2건(omf-all-around#68 · 장부 P-101) — 스캔 한 번에 필요한 것과, 의뢰 하나의 시리얼 판정.
 * ⚠ 시리얼당 한 줄이라 회차별 이력이 없다 — 현재 1차·최종과 마지막으로 쓴 회차만 낸다.
 */
@Injectable()
export class OqcSerialQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** 스캔 — 시리얼·LOT, 지금의 OQC 기록, 그 LOT 을 피킹한 OQC 의뢰(상태와 함께). */
  async scan(serialNo: string, scope?: TerminalQualityReadScope) {
    const serial = await this.prisma.serial_number.findUnique({
      where: { serial_no: serialNo },
      select: {
        serial_number_id: true, serial_no: true, item_id: true, lot_id: true, produced_at: true,
        item: { select: { item_code: true, item_name: true } },
        lot: { select: { lot_no: true, source_type_code: true, source_id: true } },
        oqc_serial_result: { select: RECORD_SELECT },
      },
    });
    if (serial === null) throw new NotFoundException('없는 시리얼입니다.');
    return omitEmpty({
      serialNumberId: Number(serial.serial_number_id),
      serialNo: serial.serial_no,
      itemId: Number(serial.item_id),
      itemCode: serial.item.item_code,
      itemName: serial.item.item_name,
      lotId: Number(serial.lot_id),
      lotNo: serial.lot.lot_no,
      producedAt: serial.produced_at?.toISOString(),
      workOrderId: serial.lot.source_type_code === 'WORK_ORDER' ? Number(serial.lot.source_id) : undefined,
      shipmentStep: serial.oqc_serial_result === null ? undefined : recordView(serial.oqc_serial_result),
      pickedRequests: await this.pickedRequests(serial.item_id, serial.lot_id, scope),
    });
  }

  /** 의뢰 하나의 회차들이 쓴 시리얼 판정 — 시리얼 번호순. */
  async ofRequest(inspectionRequestId: number) {
    const rows = await this.prisma.oqc_serial_result.findMany({
      where: { inspection_result: { inspection_request_id: inspectionRequestId } },
      select: {
        ...RECORD_SELECT,
        serial_number: { select: { serial_number_id: true, serial_no: true, lot_id: true, lot: { select: { lot_no: true } } } },
      },
      orderBy: { serial_number: { serial_no: 'asc' } },
    });
    return {
      items: rows.map((row) => ({
        serialNumberId: Number(row.serial_number.serial_number_id),
        serialNo: row.serial_number.serial_no,
        lotId: Number(row.serial_number.lot_id),
        lotNo: row.serial_number.lot.lot_no,
        ...recordView(row),
      })),
    };
  }

  /** 피킹 LOT 판단은 `oqcPickedLots` 와 같다 — 남은 예약(reserved − released > 0)이 그 LOT 을 쥔 검사 대상 라인. */
  private async pickedRequests(itemId: bigint, lotId: bigint, scope: TerminalQualityReadScope | undefined) {
    const reservations = await this.prisma.inventory_reservation.findMany({
      where: { source_document_type_code: SHIPMENT_REQUEST_LINE, lot_id: lotId },
      select: { source_document_id: true, reserved_qty: true, released_qty: true },
    });
    const lineIds = reservations
      .filter((row) => new Prisma.Decimal(row.reserved_qty).minus(row.released_qty).greaterThan(0))
      .map((row) => row.source_document_id);
    if (lineIds.length === 0) return [];
    const lines = await this.prisma.shipment_request_line.findMany({
      where: { shipment_request_line_id: { in: lineIds }, shipping_inspection_required: true, item_id: itemId },
      select: { shipment_request_id: true },
    });
    if (lines.length === 0) return [];
    const where: Prisma.inspection_requestWhereInput = {
      inspection_type_code: 'OQC',
      target_type_code: 'SHIPMENT_REQUEST',
      target_id: { in: lines.map((line) => line.shipment_request_id) },
      item_id: itemId,
      status_code: { in: REQUEST_STATUS_CODES },
    };
    const rows = await this.prisma.inspection_request.findMany({
      where: scope === undefined ? where : { AND: [where, await terminalInspectionRequestWhere(this.prisma, scope)] },
      select: { inspection_request_id: true, inspection_request_no: true, target_id: true, status_code: true },
      orderBy: { inspection_request_id: 'asc' },
    });
    return rows.map((row) => ({
      inspectionRequestId: Number(row.inspection_request_id),
      inspectionRequestNo: row.inspection_request_no,
      shipmentRequestId: Number(row.target_id),
      statusCode: row.status_code,
    }));
  }
}

const RECORD_SELECT = {
  first_judgment_code: true,
  final_judgment_code: true,
  inspected_at: true,
  inspected_worker: { select: { worker_name: true } },
  inspection_result: { select: { inspection_result_id: true, inspection_round: true } },
} satisfies Prisma.oqc_serial_resultSelect;

type RecordRow = Prisma.oqc_serial_resultGetPayload<{ select: typeof RECORD_SELECT }>;

function recordView(row: RecordRow) {
  return omitEmpty({
    firstJudgmentCode: row.first_judgment_code,
    finalJudgmentCode: row.final_judgment_code,
    inspectedAt: row.inspected_at.toISOString(),
    inspectorName: row.inspected_worker?.worker_name,
    inspectionResultId: Number(row.inspection_result.inspection_result_id),
    inspectionRound: row.inspection_result.inspection_round,
  });
}
