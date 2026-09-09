import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { OqcInspectionRow } from './shipment-inspection';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';
import { ShipmentPicksByLine, ShipmentRequestView, shipmentRequestView } from './shipment-request-view';

/** 03 품질에서 이 축이 세는 것 — 출하검사뿐이다(§1-5). 좁히기용이고 판정은 ③a 가 다시 한다. */
const OQC = 'OQC';
const LOT = 'LOT';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

/**
 * 출하작업지시 단건 조회 — 화면 `W-04-02`(목록에서 연 상세) · `M-04-01`(피킹).
 *
 * ⛔ 이 오퍼레이션은 멱등·If-Match·ETag·403 이 전부 0건이다(계약 실측 · I-22 §1-1) —
 * `runIdempotent`·`runVersioned`·`setEtag` 를 부르지 않는다. 200 과 404 뿐이다.
 */
@Injectable()
export class ShipmentRequestQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async get(shipmentRequestId: number): Promise<ShipmentRequestView> {
    const row = await this.prisma.shipment_request.findUnique({
      where: { shipment_request_id: shipmentRequestId },
      include: { shipment_request_line: { orderBy: { line_no: 'asc' } } },
    });
    if (!row) throw new NotFoundException('없는 출하작업지시입니다.');

    const picks = await this.picksByLine(
      row.shipment_request_line.map((line) => line.shipment_request_line_id),
    );
    // ⛔ 맵 «전체»를 훑지 않는다 — 이 건의 라인에서 뽑는다. 앞 질의가 느슨해지면 섞여 든 남의
    //    LOT 이 그대로 둘째 질의의 `IN` 목록으로 새 나간다(응답은 ③a 가 다시 걸러 안 바뀐다).
    const lotIds = row.shipment_request_line
      .flatMap((line) => picks.get(String(line.shipment_request_line_id)) ?? [])
      .flatMap((pick) => (pick.lot_id === null ? [] : [pick.lot_id]));
    return shipmentRequestView(row, picks, await this.oqcResults(row.shipment_request_id, lotIds));
  }

  /**
   * ⭐ 라인 id 를 **모아 한 방**으로 읽는다 — 라인마다 부르면 N+1 이다.
   * ⛔ 축은 `(source_document_type_code, source_document_id)` **둘 다**다. 유형을 빼면 같은 id 를 쓰는
   *    «자재» 예약이 섞여 들어와 수량이 부풀고 남의 LOT 이 `picks[]` 에 뜬다(#409 인계 · §11 ②).
   *    `ix_reservation_source (type, id, status)` 가 그대로 탄다(§2-7).
   * ⛔ `status_code` 로 좁히지 않는다 — 계약이 「누적 피킹 수량」이라 적었고 되돌림은 **수량 축**
   *    (`released_qty`)이 감당하기로 한 자리다(§5-1 · R-14). ⚠ 그 되돌림이 **오늘은 일어나지
   *    않는다** — `released_qty` 를 쓰는 코드가 저장소에 0개이고 ⓒ안에서 `consumed = reserved` 라
   *    `ck_reservation_qty` 가 올리는 것 자체를 막는다(**통보 241** · §11 ①). 그래서 지금은 상태와
   *    무관하게 예약 행 전건이 `pickedQty` 에 남는다 — I-23 이 되돌림 칸을 정할 때 함께 푼다.
   */
  private async picksByLine(lineIds: bigint[]): Promise<ShipmentPicksByLine> {
    const rows = await this.prisma.inventory_reservation.findMany({
      where: {
        source_document_type_code: SHIPMENT_REQUEST_LINE,
        source_document_id: { in: lineIds },
      },
      include: { lot: { select: { lot_no: true } } },
      orderBy: { inventory_reservation_id: 'asc' },
    });
    const grouped: ShipmentPicksByLine = new Map();
    for (const row of rows) {
      const key = String(row.source_document_id);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return grouped;
  }

  /**
   * 검사 결과 모집단을 **느슨하게** 당겨 온다 — `CONFIRMED`·최대 회차·대상 판정은
   * `shipment-inspection.ts` 가 다시 판다(둘째 그물). 여기서는 표를 안 훑도록 좁히기만 한다.
   * ⭐ `lot_id` 는 `target_type_code` 와 **병존**한다(R-5) — LOT 축을 `target_id` 하나로 좁히면
   *   「LOT 대상인데 `lot_id` 가 다른 LOT 을 가리키는」 의뢰가 통째로 빠진다.
   */
  private async oqcResults(shipmentRequestId: bigint, lotIds: bigint[]): Promise<OqcInspectionRow[]> {
    const rows = await this.prisma.inspection_result.findMany({
      where: {
        inspection_request: {
          inspection_type_code: OQC,
          OR: [
            { lot_id: { in: lotIds } },
            { target_type_code: LOT, target_id: { in: lotIds } },
            { target_type_code: SHIPMENT_REQUEST, target_id: shipmentRequestId },
          ],
        },
      },
      include: { inspection_request: true },
    });
    return rows.map((row) => ({
      inspectionRequestId: row.inspection_request_id,
      inspectionTypeCode: row.inspection_request.inspection_type_code,
      targetTypeCode: row.inspection_request.target_type_code,
      targetId: row.inspection_request.target_id,
      lotId: row.inspection_request.lot_id,
      statusCode: row.status_code,
      inspectionRound: row.inspection_round,
      overallJudgmentCode: row.overall_judgment_code,
    }));
  }
}
