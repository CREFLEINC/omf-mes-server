import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentAllocationQueryService } from './shipment-allocation-query.service';
import { ShipmentLotAllocationView } from './shipment-allocation-view';

/** 계약 `ShipmentLotAllocationPacking` — required 1 · 프로퍼티 1. */
export interface ShipmentLotAllocationPacking {
  handlingUnitId: number;
}

export interface AllocationPackingContext {
  /** ⚠ 저장하지 않는다 — `shipment_lot_allocation` 에 담을 칸이 0개다(§7-4 「읽고 버림」형). */
  workerNo?: string;
}

/** 409 enum 다섯 중 이 자리가 쓰는 하나. `code` 는 계약 required 라 명시로 넘긴다(R-18). */
const INVALID_STATE = 'INVALID_STATE';
const HU_FIELD = 'handlingUnitId';

/**
 * ⑥ 「포장 가능 상태」 — ⛔ 값 목록을 «지어내지 않았다». 실측: 계약이 `HandlingUnit.statusCode` 를
 * `x-no-code-key` 로 닫아 코드 그룹 시드가 **0행**이고, 저장소가 쥔 값은
 * `src/inventory/handling-unit/handling-unit-status.ts:11-12` 의 둘뿐이며(`OPEN`·`PACKED`)
 * **폐기·해체를 뜻하는 값은 0개**다(통보 142 — 해체 화면이 계약에 0건).
 * ⇒ 결정 — 통보 후보. README §2 기준 2(거부하는 쪽)로 «허용 목록»을 골랐다: 없는 폐기 값 이름을
 *   지어 «거부 목록»을 세우면 기준 5(새 개념 0)에 걸린다. ⚠ 01 상수와 «두 벌»인 것은 저장소에
 *   도메인 간 import 가 0건이라서다. 픽스처의 셋째 값 `'ACTIVE'`(통보 164 ⓐ)는 여기서 거부된다.
 */
const PACKABLE_STATUS: ReadonlySet<string> = new Set(['OPEN', 'PACKED']);

interface AllocationRow {
  shipment_lot_allocation_id: bigint;
  handling_unit_id: bigint | null;
  current_handling_unit_no: string | null;
  warehouse_id: bigint;
}

/**
 * `PUT /logistics/shipment-lot-allocations/{id}` — 배분에 포장 단위를 잇는다(`P-04-01` §4-C).
 * ⛔ `handling_unit_content` 를 **만들지 않는다** — 내용물은 01 계약(`:pack`)이 소유한다(§3-3).
 */
@Injectable()
export class AllocationPackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ShipmentAllocationQueryService,
  ) {}

  async pack(
    shipmentLotAllocationId: number,
    body: ShipmentLotAllocationPacking,
    context: AllocationPackingContext,
  ): Promise<ShipmentLotAllocationView> {
    // ① 계약 가드가 헤더를 «안 본다»(`contract-validation.guard.ts:39`) — 서버가 유일한 그물이다.
    assertWorkerNo(context.workerNo);
    const handlingUnitId = BigInt(body.handlingUnitId);

    await this.prisma.$transaction(async (tx) => {
      const allocation = await lockAllocation(tx, shipmentLotAllocationId);
      // ③ ⛔ 404 는 «배분»에만이다 — 없는 HU 는 ④ 의 400 `INVALID` 다(A-25).
      if (allocation === undefined) throw new NotFoundException('없는 출하 LOT 배분입니다.');

      await assertPackable(tx, handlingUnitId, allocation.warehouse_id);

      // ⑦ ⭐ 멱등의 방향이 «둘»이다 — 같은 HU 면 행을 건드리지 않고 200, 다른 HU 면 409.
      //    ⛔ 둘 중 하나만 걸면 나머지 변이가 조용히 산다(A-20·A-21 이 서로를 죽인다).
      if (allocation.handling_unit_id === handlingUnitId) return;
      if (allocation.handling_unit_id !== null) {
        // ⭐ 409 넷이 전부 `INVALID_STATE` 라 **문구가 사유를 싣는다**(R-18 · §3-4). 화면은 «현재
        //   HU»를 모르면 다음 행동(그 포장을 풀 것인가)을 정하지 못한다.
        throw conflict(`이미 다른 포장 단위에 담겼습니다. (현재 ${allocation.current_handling_unit_no})`);
      }

      await tx.shipment_lot_allocation.update({
        where: { shipment_lot_allocation_id: allocation.shipment_lot_allocation_id },
        data: { handling_unit_id: handlingUnitId },
      });
    });

    // ⑨ ⛔ 되읽기는 ⑦a 의 뷰 «그대로»다 — `oqcPassed`·`packedQty` 를 여기서 다시 세면 목록이 쓰는
    //    LOT 모집단(예약 축 · `SHIPMENT_REQUEST_LINE`)과 갈린다(⑦a 리뷰 Major-1).
    return this.queries.get(shipmentLotAllocationId);
  }
}

/** ⚠ 사번을 **읽고 버린다** — 담을 칸이 0개다. ⛔ `mdm.worker` 조회도 `maxLength` 도 안 세운다. */
function assertWorkerNo(workerNo: string | undefined): void {
  if (workerNo !== undefined && workerNo.trim() !== '') return;
  throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
}

/**
 * ③ ⭐ **`FOR UPDATE OF a`** — 배분 «한 행»만 잠근다. 헤더까지 잠그면 같은 출하의 다른 배분을 잇는
 * 스캔이 서로를 막는데, 여러 배분을 연달아 포장하는 것이 `P-04-01` 의 정상 흐름이다(⑥ 이
 * `FOR UPDATE OF l` 에 같은 이유를 적었다). ⚠ 범위를 넓혀도 HTTP 로는 안 갈린다(§12-1).
 */
async function lockAllocation(
  tx: Prisma.TransactionClient,
  shipmentLotAllocationId: number,
): Promise<AllocationRow | undefined> {
  const [row] = await tx.$queryRaw<AllocationRow[]>`
    SELECT a.shipment_lot_allocation_id, a.handling_unit_id, s.warehouse_id,
           hu.handling_unit_no AS current_handling_unit_no
      FROM logistics.shipment_lot_allocation a
      JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
      JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
      LEFT JOIN inventory.handling_unit hu ON hu.handling_unit_id = a.handling_unit_id
     WHERE a.shipment_lot_allocation_id = ${shipmentLotAllocationId}
       FOR UPDATE OF a`;
  return row;
}

/**
 * ④⑤⑥ — **순서가 판정이다**(§3-4). ⛔⛔ ⑤ 는 **널을 통과시키지 않는다** —
 * `handling_unit.warehouse_id` 는 nullable 이고 창고를 확인할 수 없으면 붙이지 않는다(기준 2 ·
 * R-13 Minor 5). ⭐ 널과 불일치를 «따로» 던진다 — 합치면 널 갈래를 지워도 대조가 대신 막아
 * 서로의 변이를 못 죽인다(§6-3 ⑴).
 */
async function assertPackable(
  tx: Prisma.TransactionClient,
  handlingUnitId: bigint,
  shipmentWarehouseId: bigint,
): Promise<void> {
  const hu = await tx.handling_unit.findUnique({
    where: { handling_unit_id: handlingUnitId },
    select: { warehouse_id: true, status_code: true },
  });
  if (hu === null) throw invalid('없는 취급 단위입니다.');
  if (hu.warehouse_id === null) throw invalid('취급 단위의 창고를 알 수 없어 연결할 수 없습니다.');
  if (hu.warehouse_id !== shipmentWarehouseId) throw invalid('출하 창고와 다른 창고의 취급 단위입니다.');
  if (!PACKABLE_STATUS.has(hu.status_code)) {
    throw invalid(`포장할 수 없는 취급 단위 상태입니다. (${hu.status_code})`);
  }
}

function invalid(message: string): ContractException {
  return one(field(HU_FIELD, ERROR_CODE.INVALID, message));
}

/** ⭐ `code` 는 계약 required 인데 공용 예외는 «선택»으로 둔다 — 이 자리가 명시로 넘긴다. */
function conflict(message: string): ConflictException {
  return new ConflictException('user', message, { code: INVALID_STATE });
}
