import { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering/numbering.service';
import { resolveInspectionPlanVersion } from '../../core/quality/inspection-plan-version';

/** 출하검사. 의뢰·결과·판정이 모두 이 문자열로 묶인다(`shipment-oqc.ts` 와 같은 값). */
const OQC = 'OQC';
/** 채번 키 — 접두어 `IRQ`(`numbering.service.ts`). */
const INSPECTION_REQUEST_DOCUMENT_TYPE = 'INSPECTION_REQUEST';
/** 의뢰가 서는 첫 상태(시드 `INSPECTION_REQUEST_STATUS`). IQC 선례와 같다. */
const REQUESTED = 'REQUESTED';

/** 편성 본문에서 이 모듈이 보는 것만. */
export interface OqcRequestLine {
  itemId: number;
  uomId: number;
  allocatedQty: number;
  shippingInspectionRequired: boolean;
}

/** 트랜잭션 «밖»에서 다 마친 한 건. 안에서는 그대로 INSERT 하기만 한다. */
export interface PreparedOqcRequest {
  requestNo: string;
  itemId: number;
  uomId: number;
  targetQty: number;
  planVersionId: bigint;
}

/**
 * 편성이 만들 OQC 의뢰를 **품목별로** 묶는다.
 *
 * ⭐ **왜 품목별인가.** 편성 시점에는 LOT 이 아직 없다 — 예약은 `:pick` 이 건다. 그래서
 * 의뢰는 헤더 대상(`SHIPMENT_REQUEST` · `lot_id` null)일 수밖에 없는데, 물리가
 * `item_id`·`uom_id`·`target_qty` 를 NOT NULL 로 요구한다. 헤더에는 그 셋이 없으므로
 * 품목이 여럿이면 의뢰도 여럿이 된다.
 *
 * ⚠ **의도된 거친 판정.** 헤더 대상 의뢰 하나는 그 지시의 «모든» 필수 라인을 물들인다
 * (`shipment-inspection.ts` 의 `targetsLine` — `target_id` 가 지시이고 `lot_id` 가 null이면
 * 라인을 가리지 않는다). 그래서 품목별로 나눠 만들어도 서로의 라인까지 함께 물들여,
 * 실질은 「전 의뢰 합격 = 전 라인 PASSED」가 된다. 품목 하나가 떨어지면 전 라인이 막히는
 * 쪽이라 안전한 방향이고, 설계 문의 195 ②가 이 동작을 묻고 있어 선행 구현으로 확정한다.
 *
 * ⛔ **`uom_id` 는 그 품목의 «첫» 필수 라인 것을 쓴다.** 한 품목이 라인마다 다른 단위로
 * 오면 수량 합이 단위를 섞게 되는데, 그 경우를 막을 근거가 계약에 없다 — 실제로 섞여
 * 들어오면 검사 수량이 뜻을 잃으므로, 그때는 이 자리에 단위별 분할을 더해야 한다.
 */
export function groupOqcLines(lines: OqcRequestLine[]): Map<number, { uomId: number; qty: number }> {
  const byItem = new Map<number, { uomId: number; qty: number }>();
  for (const line of lines) {
    if (!line.shippingInspectionRequired) continue;
    const found = byItem.get(line.itemId);
    if (found === undefined) byItem.set(line.itemId, { uomId: line.uomId, qty: line.allocatedQty });
    else found.qty += line.allocatedQty;
  }
  return byItem;
}

/**
 * 트랜잭션 **밖**에서 검사 기준을 풀고 번호를 뽑는다.
 *
 * ⛔⛔ 채번을 `$transaction` 안에서 부르면 한 요청이 커넥션을 둘 쥐고, 동시 요청이 풀에
 * 이르면 서로를 기다려 `P2024` 로 죽는다(편성이 자기 번호를 밖에서 뽑는 것과 같은 이유).
 * ⛔ 기준 버전 조회도 밖이다 — 없거나 둘이면 **400 으로 편성을 막는** 검사라, 트랜잭션을
 * 열어 놓고 던지면 롤백할 것이 없는데도 커넥션을 잡고 있게 된다.
 *
 * ⚠ 기준이 없으면 던지는 쪽을 골랐다. 라인의 `shipping_inspection_required` 가 이미
 * 「검사 불요」를 뜻하므로, 필수라고 해 놓고 기준이 없는 것은 마스터 결손이다. 조용히
 * 넘기면 그 출하는 결과가 영영 안 생겨 판정이 `PENDING` 에 갇힌다.
 */
export async function prepareOqcRequests(
  prisma: Prisma.TransactionClient,
  numbering: NumberingService,
  lines: OqcRequestLine[],
  requestedShipDate: string,
): Promise<PreparedOqcRequest[]> {
  const byItem = groupOqcLines(lines);
  if (byItem.size === 0) return [];

  const items = [...byItem.entries()].sort(([a], [b]) => a - b);
  const planVersions = await Promise.all(
    items.map(([itemId]) => resolveInspectionPlanVersion(prisma, OQC, itemId, requestedShipDate)),
  );
  const numbers = await numbering.nextMany(
    INSPECTION_REQUEST_DOCUMENT_TYPE,
    null,
    requestedShipDate,
    items.length,
  );

  return items.map(([itemId, { uomId, qty }], index) => ({
    requestNo: numbers[index],
    itemId,
    uomId,
    targetQty: qty,
    planVersionId: planVersions[index],
  }));
}

/**
 * 준비된 의뢰를 편성 트랜잭션 안에 세운다.
 *
 * ⛔ **이미 `REQUESTED` 인 의뢰가 있는 (대상, 품목)은 건너뛴다.** IQC 는 DB 가 막아 주지만
 * (`uq_iqc_inspection_request_lot`) OQC 에는 그런 제약이 없어 서버가 지켜야 한다.
 * 편성 재전송은 멱등 기록이 막지만, 그 밖의 경로로 같은 지시에 다시 오면 여기서 걸린다.
 */
export async function writeOqcRequests(
  tx: Prisma.TransactionClient,
  shipmentRequestId: bigint,
  prepared: PreparedOqcRequest[],
  appUserId: number,
  requestedAt: Date,
): Promise<void> {
  if (prepared.length === 0) return;
  const existing = await tx.inspection_request.findMany({
    where: {
      inspection_type_code: OQC,
      target_type_code: 'SHIPMENT_REQUEST',
      target_id: shipmentRequestId,
      status_code: REQUESTED,
    },
    select: { item_id: true },
  });
  const already = new Set(existing.map((row) => row.item_id));

  for (const request of prepared) {
    if (already.has(BigInt(request.itemId))) continue;
    await tx.inspection_request.create({
      data: {
        inspection_request_no: request.requestNo,
        inspection_type_code: OQC,
        inspection_plan_version_id: request.planVersionId,
        target_type_code: 'SHIPMENT_REQUEST',
        target_id: shipmentRequestId,
        item_id: BigInt(request.itemId),
        // ⛔ `lot_id` 는 null 이다 — 편성 시점에 LOT 이 없고, null 이어야 헤더 대상이
        //    그 지시의 모든 필수 라인을 물들인다(`shipment-inspection.ts` 의 판정).
        lot_id: null,
        target_qty: request.targetQty,
        uom_id: BigInt(request.uomId),
        status_code: REQUESTED,
        requested_at: requestedAt,
        created_by: appUserId,
      },
    });
  }
}
