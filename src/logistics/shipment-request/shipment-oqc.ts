import { PrismaService } from '../../prisma/prisma.service';
import { OqcInspectionRow, ShipmentInspectionLine, oqcPassed } from './shipment-inspection';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';

/**
 * **출하 라인별 `oqcPassed` 한 자리** — I-22 `shipment-allocation-query.service.ts` 에 있던 것을
 * 밖으로 뽑았다(I-23 PR ②b). 사용처가 **둘**이라 공용이다: 배분 목록(P-04-01·P-04-02)과 출하
 * 상세(`GET /logistics/shipments/{id}`). ⛔ 복제하면 **같은 배분의 `oqcPassed` 가 두 화면에서
 * 갈린다** — I-22 R-10 이 금한 자리다.
 *
 * ⭐⭐ **LOT 모집단은 «배분»이 아니라 «예약»이다**(`inventory_reservation` ×
 * `SHIPMENT_REQUEST_LINE`) — I-22 §5-2 정본이 `picks[].lotId` 라 못박았다. `shipment_lot_
 * allocation` 에서 세우면 라인이 피킹한 LOT 중 **이번 출하엔 배정되지 않은** LOT 의 불합격이
 * 안 보여, 검사 화면과 발행 대상 목록이 갈린다.
 * ⭐ 후보 «행»이 아니라 그 라인들의 예약 **전건**으로 센다 — 필터가 좁혀도(예: `handlingUnitId`)
 * 같은 배분의 값이 필터에 따라 갈리면 안 된다.
 */

const OQC = 'OQC';
const LOT = 'LOT';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

/** `shipment_request_line_id`(문자열) → 그 라인의 `oqcPassed`. */
export type OqcPassedByLine = Map<string, boolean>;

export async function oqcPassedByLine(
  prisma: PrismaService,
  lineIds: bigint[],
): Promise<OqcPassedByLine> {
  const ids = [...new Set(lineIds.map(String))].map(BigInt);
  if (ids.length === 0) return new Map();
  const lines = await prisma.shipment_request_line.findMany({
    where: { shipment_request_line_id: { in: ids } },
    select: {
      shipment_request_line_id: true,
      shipment_request_id: true,
      shipping_inspection_required: true,
    },
  });
  const picks = await prisma.inventory_reservation.findMany({
    where: { source_document_type_code: SHIPMENT_REQUEST_LINE, source_document_id: { in: ids } },
    select: { source_document_id: true, lot_id: true },
  });
  const lotsByLine = new Map<string, Set<string>>();
  for (const row of picks) {
    if (row.lot_id === null) continue;
    const key = String(row.source_document_id);
    const set = lotsByLine.get(key) ?? new Set<string>();
    set.add(String(row.lot_id));
    lotsByLine.set(key, set);
  }
  const inspections = await oqcResults(
    prisma,
    lines.map((line) => line.shipment_request_id),
    [...new Set(picks.flatMap((row) => (row.lot_id === null ? [] : [row.lot_id])))],
  );
  const result: OqcPassedByLine = new Map();
  for (const line of lines) {
    const key = String(line.shipment_request_line_id);
    const inspectionLine: ShipmentInspectionLine = {
      shipmentRequestId: line.shipment_request_id,
      shippingInspectionRequired: line.shipping_inspection_required,
      lotIds: [...(lotsByLine.get(key) ?? new Set<string>())].map((id) => BigInt(id)),
    };
    result.set(key, oqcPassed(inspectionLine, inspections));
  }
  return result;
}

/**
 * 첫 그물 — 세 축 중 하나라도 걸리는 결과를 모은다. **둘째 그물은 `oqcPassed()` 가 다시 판다**
 * (헤더 대상 의뢰와 LOT 대상 의뢰가 병존할 수 있어 여기서 좁히면 놓친다).
 */
async function oqcResults(
  prisma: PrismaService,
  shipmentRequestIds: bigint[],
  lotIds: bigint[],
): Promise<OqcInspectionRow[]> {
  const rows = await prisma.inspection_result.findMany({
    where: {
      inspection_request: {
        inspection_type_code: OQC,
        OR: [
          { lot_id: { in: lotIds } },
          { target_type_code: LOT, target_id: { in: lotIds } },
          { target_type_code: SHIPMENT_REQUEST, target_id: { in: shipmentRequestIds } },
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
