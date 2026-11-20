import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertBusinessUnitAndWarehouses, assertSalesOrderRemaining } from './shipment-request-create-rules';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestView } from './shipment-request-view';
import { ShipmentRequestCreate, ShipmentRequestService } from './shipment-request.service';
import { LogisticsHandoverNotifier } from '../logistics-handover';

const HANDOVER = {
  shipmentPicking: async () => undefined,
  oqcRequested: async () => undefined,
} as unknown as LogisticsHandoverNotifier;

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
  oqc: Record<string, unknown>[];
}

function stub() {
  const recorded: Recorded = { order: [], numbered: [], header: {}, lines: [], oqc: [] };
  const prisma = {
    sales_order: { count: async () => 1 },
    partner: { findMany: async () => [{ partner_id: 11n }, { partner_id: 12n }] },
    item: { findMany: async () => [{ item_id: 21n }] },
    uom: { findMany: async () => [{ uom_id: 31n }] },
    sales_order_line: {
      findMany: async () => [{ sales_order_line_id: 41n, sales_order_id: 9n, ordered_qty: 1000, shipped_qty: 0 }],
    },
    business_unit: { findUnique: async () => ({ is_active: true }) },
    warehouse: {
      findMany: async () => [{ warehouse_id: 5n, plant_id: 4n, business_unit_id: 1n, is_active: true, is_defect: false }],
    },
    code_value: {
      findMany: async () => [{ code: 'MORNING', code_group: { group_code: 'SHIPMENT_TIME_SLOT' } }],
    },
    // 검사 필수 라인이 있을 때만 불린다(기본 본문은 불요라 안 불린다).
    inspection_plan_version: {
      findMany: async () => {
        recorded.order.push('oqc-plan');
        return [{ inspection_plan_version_id: 77n }];
      },
      findUnique: async () => ({ inspection_plan: { default_skip: false } }),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      recorded.order.push('transaction');
      return work({
        inspection_request: {
          findMany: async () => [],
          create: async ({ data }: { data: Record<string, unknown> }) => {
            recorded.order.push('oqc-request');
            recorded.oqc.push(data);
            return { inspection_request_id: 91n };
          },
        },
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
    nextMany: async (type: string, plantId: bigint | null, periodDate: string, count: number) => {
      recorded.order.push('oqc-numbering');
      recorded.numbered.push([type, plantId, periodDate]);
      return Array.from({ length: count }, (_, i) => `IRQ-20260921-000${i + 1}`);
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
      HANDOVER,
    ),
    recorded,
  };
}

function body(overrides: Partial<ShipmentRequestCreate> = {}): ShipmentRequestCreate {
  return {
    customerId: 11,
    shipToPartnerId: 12,
    requestedShipDate: '2026-09-21',
    businessUnitId: 1,
    lines: [
      { itemId: 21, requestedQty: 100, allocatedQty: 60, uomId: 31, shippingInspectionRequired: false, warehouseId: 5 },
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

  it('⭐⭐ OQC 기준 조회와 의뢰 채번도 $transaction 「밖」이다', async () => {
    const harness = stub();

    await harness.service.create(
      body({
        lines: [
          { itemId: 21, requestedQty: 100, allocatedQty: 60, uomId: 31, shippingInspectionRequired: true, warehouseId: 5 },
        ],
      }),
      ACTOR,
    );

    // ⛔ 채번이 트랜잭션 안으로 들어가면 커넥션을 둘 쥔다(위 시험과 같은 이유).
    // ⛔ 기준 조회도 밖이다 — 없으면 400 으로 «편성을 막는» 검사라, 트랜잭션을 열어 놓고
    //    던지면 롤백할 것이 없는데도 커넥션을 잡고 있게 된다.
    expect(harness.recorded.order).toEqual([
      'numbering',
      'oqc-plan',
      'oqc-numbering',
      'transaction',
      'header',
      'lines',
      'oqc-request',
      'readback',
    ]);
    expect(harness.recorded.oqc).toHaveLength(1);
    expect(harness.recorded.oqc[0]).toMatchObject({
      inspection_type_code: 'OQC',
      target_type_code: 'SHIPMENT_REQUEST',
      target_id: 77n,
      lot_id: null,
      status_code: 'REQUESTED',
      inspection_plan_version_id: 77n,
    });
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
          { itemId: 21, requestedQty: 100, allocatedQty: 60, uomId: 31, shippingInspectionRequired: true, warehouseId: 5 },
          { itemId: 21, requestedQty: 50, allocatedQty: 50, uomId: 31, shippingInspectionRequired: false, warehouseId: 5 },
        ],
      }),
      ACTOR,
    );

    expect(harness.recorded.header).toMatchObject({
      shipment_request_no: 'SR-20260921-0001',
      status_code: 'REGISTERED',
      created_by: 3,
      // 피처 012 D-1 — 사업부를 싣고 공장은 비운다.
      business_unit_id: 1,
      fulfillment_plant_id: null,
    });
    expect(harness.recorded.lines.map((row) => row.warehouse_id)).toEqual([5, 5]);
    // ⛔ `version_no` 를 손으로 넣지 않는다 — 물리 기본값 1 이다(§3-1 ⑦-1).
    expect(harness.recorded.header).not.toHaveProperty('version_no');
    expect(harness.recorded.lines.map((row) => row.line_no)).toEqual([1, 2]);
    expect(harness.recorded.lines.map((row) => row.created_by)).toEqual([3, 3]);
    // ⛔ `shipped_qty` 도 안 넣는다 — 올리는 것은 I-23 출하 확정이다.
    expect(harness.recorded.lines[0]).not.toHaveProperty('shipped_qty');
  });
});

/** 피처 012 R-8 — 사업부·줄 출고 창고(필수·422, 범위 밖 403)와 S/O 줄 나누기 합계(D-3). */
describe('출하작업지시 편성 — 사업부·줄 출고 창고·S/O 나누기 (피처 012)', () => {
  type Warehouse = { warehouse_id: bigint; plant_id: bigint; business_unit_id: bigint; is_active: boolean; is_defect: boolean };
  const A: Warehouse = { warehouse_id: 5n, plant_id: 4n, business_unit_id: 1n, is_active: true, is_defect: false };
  const B: Warehouse = { warehouse_id: 6n, plant_id: 7n, business_unit_id: 1n, is_active: true, is_defect: false };
  const db = (unit: { is_active: boolean } | null, warehouses: Warehouse[]) => ({
    business_unit: { findUnique: async () => unit },
    warehouse: { findMany: async () => warehouses },
  }) as unknown as PrismaService;
  const input = (warehouseIds: (number | null)[], businessUnitId: number | null = 1) =>
    ({ businessUnitId, lines: warehouseIds.map((warehouseId) => ({ warehouseId })) });
  const fieldsOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (thrown: unknown) => thrown as { getStatus: () => number; getResponse: () => { errors: { field: string }[] } });
    return error === null ? null : { status: error.getStatus(), fields: error.getResponse().errors.map((item) => item.field) };
  };

  it('US1-2 사업부가 없으면 422 businessUnitId, US1-6 창고 빈 줄은 422 lines[n].warehouseId', async () => {
    expect(await fieldsOf(assertBusinessUnitAndWarehouses(db({ is_active: true }, [A]), input([5, null], null), [])))
      .toEqual({ status: 422, fields: ['businessUnitId', 'lines[1].warehouseId'] });
  });

  it('US1-3 다른 사업부·불량창고·비활성 창고는 422 lines[n].warehouseId', async () => {
    const other = { ...A, warehouse_id: 8n, business_unit_id: 2n };
    const defect = { ...A, warehouse_id: 9n, is_defect: true };
    const inactive = { ...A, warehouse_id: 10n, is_active: false };
    expect(await fieldsOf(assertBusinessUnitAndWarehouses(db({ is_active: true }, [A, other, defect, inactive]), input([5, 8, 9, 10]), [])))
      .toEqual({ status: 422, fields: ['lines[1].warehouseId', 'lines[2].warehouseId', 'lines[3].warehouseId'] });
  });

  it('US1-3 비활성 사업부는 422, 계정 범위 밖 사업부는 403', async () => {
    expect(await fieldsOf(assertBusinessUnitAndWarehouses(db({ is_active: false }, [A]), input([5]), [])))
      .toEqual({ status: 422, fields: ['businessUnitId'] });
    expect(await fieldsOf(assertBusinessUnitAndWarehouses(db({ is_active: true }, [A]), input([5]), [{ businessUnitId: 2 }])))
      .toEqual({ status: 403, fields: ['businessUnitId'] });
  });

  it('Edge-scope 범위 없는 계정·사업부 범위 계정은 사업부 안 공장 둘의 창고를 고른다, 공장만 범위 계정은 다른 공장 창고가 403', async () => {
    await expect(assertBusinessUnitAndWarehouses(db({ is_active: true }, [A, B]), input([5, 6]), [])).resolves.toBeUndefined();
    await expect(assertBusinessUnitAndWarehouses(db({ is_active: true }, [A, B]), input([5, 6]), [{ businessUnitId: 1 }])).resolves.toBeUndefined();
    expect(await fieldsOf(assertBusinessUnitAndWarehouses(db({ is_active: true }, [A, B]), input([5, 6]), [{ businessUnitId: 1, plantId: 4 }])))
      .toEqual({ status: 403, fields: ['lines[1].warehouseId'] });
  });

  it('US1-5·Q4 같은 S/O 줄을 나눈 줄의 배정 합이 잔여(주문 − 출하) 이하면 통과, 넘으면 그 줄 모두 422', async () => {
    const order = [{ sales_order_line_id: 41n, ordered_qty: 120, shipped_qty: 20 }];
    expect(() => assertSalesOrderRemaining([
      { salesOrderLineId: 41, allocatedQty: 60 }, { salesOrderLineId: 41, allocatedQty: 40 },
    ], order)).not.toThrow();
    let thrown: { getStatus: () => number; getResponse: () => { errors: { field: string; message: string }[] } } | undefined;
    try {
      assertSalesOrderRemaining([
        { salesOrderLineId: 41, allocatedQty: 70 }, { salesOrderLineId: null, allocatedQty: 5 }, { salesOrderLineId: 41, allocatedQty: 40 },
      ], order);
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown?.getStatus()).toBe(422);
    expect(thrown?.getResponse().errors).toEqual([
      expect.objectContaining({ field: 'lines[0].allocatedQty', message: 'S/O 잔여 수량을 넘습니다.' }),
      expect.objectContaining({ field: 'lines[2].allocatedQty', message: 'S/O 잔여 수량을 넘습니다.' }),
    ]);
  });

  it('D-1 fulfillmentPlantId 를 보내면 400 — 참조 질의 전에 막는다', async () => {
    const harness = stub();
    await expect(harness.service.create(body({ fulfillmentPlantId: 3 }), ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(harness.recorded.order).toEqual([]);
  });
});
