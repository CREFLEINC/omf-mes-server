/**
 * 출하검사 5값 — 계약 `ShipmentRequest.shippingInspectionStatusCode`(헤더 required 칸) **와**
 * `ShipmentLotAllocation.oqcPassed` 를 **한 함수**로 낸다(I-22 §5-2 · R-5·R-10).
 *
 * ⛔⛔ `oqcPassed` 를 LOT 축만으로 따로 내면 안 된다(R-10) — OQC 를 «헤더 대상»으로 낸 작업지시에서
 *    `W-04-02` 는 「합격」, `W-04-04` 는 통과인데 `P-04-02` 의 `oqcPassed` 만 false 가 되어
 *    「합격인데 납품라벨을 영원히 못 뽑는」 영구 상태가 된다(`P-04-02` §5-6 이 「발행 취소 ⛔ 두지
 *    않는다」라 되돌릴 수도 없다). ⇒ 같은 `lineInspectionStatus()` 를 재사용한다.
 * ⚠ 라인별 판정은 **계약 필드가 아니라 롤업의 내부 중간값**이다 — `ShipmentRequestLine` 에는
 *   `shippingInspectionRequired`(boolean)뿐이다.
 * ⭐ 호출자(PR ④·⑦a)가 `inspection_type_code='OQC'` 로 좁혀 읽어 와도 `CONFIRMED`·최대 회차·대상
 *   판정은 **여기서 다시 판다** — 질의가 느슨해져도 롤업이 안 새게 하는 둘째 그물이다.
 */

export type ShippingInspectionStatusCode = 'NOT_REQUIRED' | 'PENDING' | 'PASSED' | 'REJECTED' | 'HELD';

/** 03 품질 `inspection_result` × `inspection_request` 한 줄. */
export interface OqcInspectionRow {
  inspectionRequestId: bigint | number;
  inspectionTypeCode: string;
  targetTypeCode: string;
  targetId: bigint | number;
  /** ⭐ `target_type_code` 와 **병존**한다 — 헤더 대상 의뢰도 어느 LOT 인지 적을 수 있다(R-5). */
  lotId: bigint | number | null;
  statusCode: string;
  inspectionRound: number;
  overallJudgmentCode: string | null;
}

export interface ShipmentInspectionLine {
  shipmentRequestId: bigint | number;
  shippingInspectionRequired: boolean;
  /** 이 라인이 집은 LOT 집합 — `picks[].lotId`. */
  lotIds: (bigint | number)[];
}

const OQC = 'OQC';
/** ⭐ 결과의 `status_code` 4값 중 확정된 것. DRAFT 를 세면 미확정 판정이 롤업에 샌다(I-21 R-3 형). */
const CONFIRMED = 'CONFIRMED';
const LOT = 'LOT';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

const key = (value: bigint | number): string => String(value);

/**
 * 이 의뢰가 이 라인을 겨누는가. ⭐ 헤더 갈래에서 `lot_id` 를 **버리지 않는다**(R-5) — 버리면
 * 헤더 검사 하나가 그 작업지시의 **모든** 라인을 물들인다. `lot_id` 가 널일 때만 라인 전체가 대상이다.
 */
function targetsLine(row: OqcInspectionRow, line: ShipmentInspectionLine, lots: Set<string>): boolean {
  if (row.targetTypeCode === LOT) return lots.has(key(row.lotId ?? row.targetId));
  if (row.targetTypeCode !== SHIPMENT_REQUEST) return false;
  if (key(row.targetId) !== key(line.shipmentRequestId)) return false;
  return row.lotId === null || lots.has(key(row.lotId));
}

/**
 * 라인 하나의 검사 상태. 모집단 0건 → `PENDING` · `REJECTED` 하나라도 → `REJECTED` ·
 * `HELD` 하나라도 → `HELD` · 그 밖(전건 `ACCEPTED`) → `PASSED`.
 * ⭐ 회차는 **그 의뢰의 CONFIRMED 최대 회차**만 센다 — 재검사가 뒤집은 판정을 구회차가 되살린다.
 */
export function lineInspectionStatus(line: ShipmentInspectionLine, rows: OqcInspectionRow[]): ShippingInspectionStatusCode {
  if (!line.shippingInspectionRequired) return 'NOT_REQUIRED';
  const lots = new Set(line.lotIds.map(key));
  const confirmed = rows.filter(
    (row) => row.inspectionTypeCode === OQC && row.statusCode === CONFIRMED && targetsLine(row, line, lots),
  );
  const latest = new Map<string, number>();
  for (const row of confirmed) {
    const round = latest.get(key(row.inspectionRequestId));
    if (round === undefined || row.inspectionRound > round) latest.set(key(row.inspectionRequestId), row.inspectionRound);
  }
  const counted = confirmed.filter((row) => row.inspectionRound === latest.get(key(row.inspectionRequestId)));
  if (counted.length === 0) return 'PENDING';
  if (counted.some((row) => row.overallJudgmentCode === 'REJECTED')) return 'REJECTED';
  if (counted.some((row) => row.overallJudgmentCode === 'HELD')) return 'HELD';
  return 'PASSED';
}

/** 계약 명시 — 롤업 우선순위는 「가장 나쁜 것이 이긴다」. 라인이 0건이면 `NOT_REQUIRED` 다. */
const PRIORITY: ShippingInspectionStatusCode[] = ['REJECTED', 'HELD', 'PENDING', 'PASSED', 'NOT_REQUIRED'];

export function shipmentInspectionStatus(
  lines: ShipmentInspectionLine[],
  rows: OqcInspectionRow[],
): ShippingInspectionStatusCode {
  const values = new Set(lines.map((line) => lineInspectionStatus(line, rows)));
  return PRIORITY.find((code) => values.has(code)) ?? 'NOT_REQUIRED';
}

/**
 * 배분 하나의 `oqcPassed` — 그 배분이 매달린 라인(`shipment_line → shipment_request_line`)의 검사
 * 상태를 **같은 함수**로 낸다(R-10).
 * ⚠ 「검사 대상이 아닌 배분은 `true`」는 계약이 명시한 것이다 — 「검사를 안 거쳤다」가 「발행하면
 *   안 된다」가 아니다(「알려둘 것」 ⓕ).
 */
export function oqcPassed(line: ShipmentInspectionLine, rows: OqcInspectionRow[]): boolean {
  if (!line.shippingInspectionRequired) return true;
  return lineInspectionStatus(line, rows) === 'PASSED';
}
