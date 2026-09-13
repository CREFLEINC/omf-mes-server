import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestView } from './shipment-request-view';
import { ShipmentRequestCreate, ShipmentRequestService } from './shipment-request.service';

const ACTOR = { appUserId: 3, scopes: [] };

/**
 * ⭐⭐ **e2e 로는 구조적으로 못 잡는 축 하나**를 여기서 잠근다(README §6-2 · §6-3 ⑹) —
 * 「채번이 `$transaction` **밖**이다」. 채번을 안으로 옮겨도 요청 하나짜리 e2e 는 **전건 초록**이다
 * (변이 하네스 1회차 실측). 죽는 것은 커넥션 풀이 마를 때뿐이고(`P2024`) 그 조건은 기능 시험이
 * 만들지 않는다. ⇒ **호출 «순서»를 직접 센다.** 선례가 둘 있다 —
 * `material-consumption.service.spec.ts:324` · `production-result.service.spec.ts:373`.
 */

interface Recorded {
  order: string[];
  numbered: [string, bigint | null, string][];
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

function stub() {
  const recorded: Recorded = { order: [], numbered: [], header: {}, lines: [] };
  const prisma = {
    sales_order: { count: async () => 1 },
    partner: { findMany: async () => [{ partner_id: 11n }, { partner_id: 12n }] },
    item: { findMany: async () => [{ item_id: 21n }] },
    uom: { findMany: async () => [{ uom_id: 31n }] },
    sales_order_line: {
      findMany: async () => [{ sales_order_line_id: 41n, sales_order_id: 9n }],
    },
    code_value: {
      findMany: async () => [{ code: 'MORNING', code_group: { group_code: 'SHIPMENT_TIME_SLOT' } }],
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      recorded.order.push('transaction');
      return work({
        shipment_request: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            recorded.order.push('header');
            recorded.header = data;
            return { shipment_request_id: 77n };
          },
        },
        shipment_request_line: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            recorded.order.push('lines');
            recorded.lines = data;
            return { count: data.length };
          },
        },
      });
    },
  };
  const numbering = {
    next: async (type: string, plantId: bigint | null, periodDate: string) => {
      recorded.order.push('numbering');
      recorded.numbered.push([type, plantId, periodDate]);
      return 'SR-20260921-0001';
    },
  };
  const queries = {
    get: async (id: number) => {
      recorded.order.push('readback');
      return { shipmentRequestId: id } as unknown as ShipmentRequestView;
    },
  };
  return {
    service: new ShipmentRequestService(
      prisma as unknown as PrismaService,
      numbering as unknown as NumberingService,
      queries as unknown as ShipmentRequestQueryService,
    ),
    recorded,
  };
}

function body(overrides: Partial<ShipmentRequestCreate> = {}): ShipmentRequestCreate {
  return {
    customerId: 11,
    shipToPartnerId: 12,
    requestedShipDate: '2026-09-21',
    lines: [
      { itemId: 21, requestedQty: 100, allocatedQty: 60, uomId: 31, shippingInspectionRequired: false },
    ],
    ...overrides,
  };
}

describe('출하작업지시 편성 — 트랜잭션 순서 (§3-1)', () => {
  it('⭐⭐ 번호를 $transaction 「밖」에서 뽑는다', async () => {
    const harness = stub();

    await harness.service.create(body(), ACTOR);

    // ⛔ 안에서 부르면 한 요청이 커넥션을 둘 쥐고, 동시 요청이 풀에 이르면 `P2024` 로 죽는다.
    //   e2e 는 이 변이를 전건 초록으로 통과시킨다 — 이 단언이 유일한 그물이다.
    expect(harness.recorded.order).toEqual([
      'numbering',
      'transaction',
      'header',
      'lines',
      'readback',
    ]);
  });

  it('⭐ 채번 기간 축이 requestedShipDate 다 — 서버가 「오늘」로 다시 잡지 않는다', async () => {
    const harness = stub();

    await harness.service.create(body({ requestedShipDate: '2031-03-01' }), ACTOR);

    // 공유계약 C-8 과 같은 이유다(자정을 넘긴 재전송이 다른 날 번호를 받는다).
    expect(harness.recorded.numbered).toEqual([['SHIPMENT_REQUEST', null, '2031-03-01']]);
  });

  it('되읽기가 ③b 의 상세 뷰다 — 201 본문을 여기서 새로 짓지 않는다', async () => {
    const harness = stub();

    const view = await harness.service.create(body(), ACTOR);

    // 두 벌을 만들면 편성 직후와 재조회가 갈린다(§4 · 파생 축 둘이 그 자리다).
    expect(view).toEqual({ shipmentRequestId: 77 });
    expect(harness.recorded.order.at(-1)).toBe('readback');
  });

  it('넣는 값 — status_code 상수 · line_no 1부터 · created_by 는 세션 계정', async () => {
    const harness = stub();

    await harness.service.create(
      body({
        lines: [
          { itemId: 21, requestedQty: 100, allocatedQty: 60, uomId: 31, shippingInspectionRequired: true },
          { itemId: 21, requestedQty: 50, allocatedQty: 50, uomId: 31, shippingInspectionRequired: false },
        ],
      }),
      ACTOR,
    );

    expect(harness.recorded.header).toMatchObject({
      shipment_request_no: 'SR-20260921-0001',
      status_code: 'REGISTERED',
      created_by: 3,
    });
    // ⛔ `version_no` 를 손으로 넣지 않는다 — 물리 기본값 1 이다(§3-1 ⑦-1).
    expect(harness.recorded.header).not.toHaveProperty('version_no');
    expect(harness.recorded.lines.map((row) => row.line_no)).toEqual([1, 2]);
    expect(harness.recorded.lines.map((row) => row.created_by)).toEqual([3, 3]);
    // ⛔ `shipped_qty` 도 안 넣는다 — 올리는 것은 I-23 출하 확정이다.
    expect(harness.recorded.lines[0]).not.toHaveProperty('shipped_qty');
  });
});

describe('출하작업지시 이행 공장 재지정', () => {
  function updateHarness(picked: boolean, warehousePlantId: bigint) {
    const updateMany = jest.fn();
    const prisma = {
      plant: { findFirst: jest.fn().mockResolvedValue({ business_unit_id: 1n }) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $queryRaw: async () => [{ shipment_request_id: 77n }],
        shipment_request: {
          findUnique: async () => ({
            shipment_request_id: 77n,
            version_no: 1,
            fulfillment_plant_id: 3n,
            shipment: [{ warehouse: { plant_id: warehousePlantId } }],
            shipment_request_line: [{ shipment_request_line_id: 501n }],
          }),
          updateMany,
        },
        inventory_reservation: {
          findFirst: async () => picked ? { inventory_reservation_id: 9n } : null,
        },
      }),
    };
    const service = new ShipmentRequestService(prisma as unknown as PrismaService,
      {} as NumberingService, {} as ShipmentRequestQueryService);
    return { service, updateMany };
  }

  const actor = { appUserId: 3, scopes: [{ businessUnitId: 1, plantId: 4 }] };

  it('피킹 예약 후에는 공장 변경을 거부하고 헤더를 갱신하지 않는다', async () => {
    const { service, updateMany } = updateHarness(true, 4n);
    await expect(service.updateFulfillmentPlant(77, 1, { fulfillmentPlantId: 4 }, actor))
      .rejects.toMatchObject({ status: 409 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('기존 출하 창고가 다른 공장이면 변경을 거부하고 헤더를 갱신하지 않는다', async () => {
    const { service, updateMany } = updateHarness(false, 3n);
    await expect(service.updateFulfillmentPlant(77, 1, { fulfillmentPlantId: 4 }, actor))
      .rejects.toMatchObject({ status: 409 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
