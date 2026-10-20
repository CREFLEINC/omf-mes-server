import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseOrderLineQueryService } from './purchase-order-line-query.service';
import {
  PurchaseOrderLineScheduleRow,
  purchaseOrderLineSchedule,
  receiptStatusOf,
  remainingQtyOf,
} from './purchase-order-line-schedule';

type Args = Record<string, unknown>;

const ORDERED_QTY_FIELD_REF = { modelName: 'purchase_order_line', name: 'ordered_qty' }; // Prisma `fields` 참조 스텁
const OPEN = {
  received_qty: { lt: ORDERED_QTY_FIELD_REF },
  cancelled_at: null,
  purchase_order: { status_code: { notIn: ['CLOSED', 'CANCELLED'] } },
};

const decimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

function row(overrides: Partial<PurchaseOrderLineScheduleRow> = {}): PurchaseOrderLineScheduleRow {
  return {
    purchase_order_line_id: 7n,
    purchase_order_id: 1n,
    line_no: 2,
    item_id: 100n,
    ordered_qty: decimal('100'),
    uom_id: 5n,
    received_qty: decimal('40'),
    tolerance_over_qty: decimal('5'),
    tolerance_under_qty: decimal('3'),
    erp_storage_location_code: 'W100',
    cancelled_at: null,
    purchase_order: {
      purchase_order_id: 1n,
      purchase_order_no: 'PO-20261020-0001',
      erp_purchase_order_no: 'PO2610200001',
      supplier_id: 10n,
      business_unit_id: 20n,
      plant_id: 30n,
      order_date: new Date('2026-10-20T00:00:00.000Z'),
      expected_receipt_date: new Date('2026-10-25T00:00:00.000Z'),
      status_code: 'REGISTERED',
    },
    ...overrides,
  } as PurchaseOrderLineScheduleRow;
}

/** `list()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁 — 넘어온 인자를 그대로 잡는다. */
function listStub(plants: { plant_id: bigint; timezone_code: string }[] = []) {
  const calls: { findMany?: Args; plantWhere?: Args } = {};
  const prisma = {
    purchase_order_line: {
      findMany: async (args: Args) => {
        calls.findMany = args;
        return [];
      },
      count: async () => 0,
      fields: { ordered_qty: ORDERED_QTY_FIELD_REF },
    },
    plant: {
      findMany: async ({ where }: { where: Args }) => {
        calls.plantWhere = where;
        return plants;
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('입하 진행 판정', () => {
  it('누적 입하 ≥ 발주면 COMPLETED — 부족 허용치를 빼지 않는다(P/O 목록 openOnly 와 같다)', () => {
    expect(receiptStatusOf(decimal('100'), decimal('100'))).toBe('COMPLETED');
    expect(receiptStatusOf(decimal('100'), decimal('103'))).toBe('COMPLETED');
    // 부족 허용치 안(97 ≥ 100 − 3)이어도 아직 PARTIAL 이다.
    expect(receiptStatusOf(decimal('100'), decimal('97'))).toBe('PARTIAL');
  });

  it('0 < 누적 입하 < 발주면 PARTIAL, 0 이면 NOT_STARTED', () => {
    expect(receiptStatusOf(decimal('100'), decimal('0.000001'))).toBe('PARTIAL');
    expect(receiptStatusOf(decimal('100'), decimal('0'))).toBe('NOT_STARTED');
  });

  it('⛔ Decimal 끝자리에서 갈린다 — 99.999999 는 아직 다 들어오지 않았다', () => {
    expect(receiptStatusOf(decimal('100'), decimal('99.999999'))).toBe('PARTIAL');
  });

  it('남은 수량은 발주 − 누적 입하이고, 초과 입하면 0 에서 자른다', () => {
    expect(remainingQtyOf(decimal('100'), decimal('40'))).toBe(60);
    expect(remainingQtyOf(decimal('100'), decimal('100'))).toBe(0);
    expect(remainingQtyOf(decimal('100'), decimal('104.5'))).toBe(0);
    expect(remainingQtyOf(decimal('0.3'), decimal('0.1'))).toBe(0.2);
  });
});

describe('purchaseOrderLineSchedule', () => {
  it('라인 칸과 헤더 칸을 한 줄로 싣고, 수량은 number 로 낸다', () => {
    expect(purchaseOrderLineSchedule(row())).toEqual({
      purchaseOrderId: 1,
      purchaseOrderNo: 'PO-20261020-0001',
      erpPurchaseOrderNo: 'PO2610200001',
      supplierId: 10,
      plantId: 30,
      orderDate: '2026-10-20',
      expectedReceiptDate: '2026-10-25',
      statusCode: 'REGISTERED',
      purchaseOrderLineId: 7,
      lineNo: 2,
      itemId: 100,
      uomId: 5,
      orderedQty: 100,
      receivedQty: 40,
      remainingQty: 60,
      toleranceOverQty: 5,
      toleranceUnderQty: 3,
      erpStorageLocationCode: 'W100',
      cancelledAt: null,
      receiptStatusCode: 'PARTIAL',
    });
  });

  it('⛔ 비어 있는 칸도 키를 생략하지 않는다 — 널로 낸다', () => {
    const cancelledAt = new Date('2026-10-21T01:02:03.000Z');
    const view = purchaseOrderLineSchedule(
      row({
        erp_storage_location_code: null,
        cancelled_at: cancelledAt,
        purchase_order: { ...row().purchase_order, erp_purchase_order_no: null, expected_receipt_date: null },
      }),
    );
    expect(view).toMatchObject({
      erpPurchaseOrderNo: null,
      expectedReceiptDate: null,
      erpStorageLocationCode: null,
      cancelledAt: '2026-10-21T01:02:03.000Z',
    });
  });
});

describe('PurchaseOrderLineQueryService', () => {
  const NOW = new Date('2026-10-20T18:30:00.000Z'); // 하노이(UTC+7)로는 10-21 01:30

  it('기본은 openOnly — 다 들어오지 않았고 라인·헤더가 취소·종료되지 않은 라인만', async () => {
    const { prisma, calls } = listStub();
    await new PurchaseOrderLineQueryService(prisma).list({}, NOW);

    expect(calls.findMany?.where).toEqual({ AND: [OPEN] });
  });

  it('openOnly=false 면 미완 조건을 걸지 않는다', async () => {
    const { prisma, calls } = listStub();
    await new PurchaseOrderLineQueryService(prisma).list({ openOnly: false }, NOW);

    expect(calls.findMany?.where).toEqual({});
  });

  it('헤더 칸(공급사·공장·납기 범위·번호 검색)은 헤더 관계 필터 하나로 모인다', async () => {
    const { prisma, calls } = listStub();
    await new PurchaseOrderLineQueryService(prisma).list(
      {
        supplierId: 10,
        plantId: 30,
        expectedReceiptDateFrom: '2026-10-01',
        expectedReceiptDateTo: '2026-10-31',
        q: '0001',
        itemId: 100,
        openOnly: false,
      },
      NOW,
    );

    expect(calls.findMany?.where).toEqual({
      AND: [
        {
          purchase_order: {
            supplier_id: 10,
            plant_id: 30,
            expected_receipt_date: {
              gte: new Date('2026-10-01T00:00:00.000Z'),
              lte: new Date('2026-10-31T00:00:00.000Z'),
            },
            OR: [
              { purchase_order_no: { contains: '0001', mode: 'insensitive' } },
              { erp_purchase_order_no: { contains: '0001', mode: 'insensitive' } },
            ],
          },
        },
        { item_id: 100 },
      ],
    });
  });

  it('overdueOnly 는 공장 현지 오늘보다 앞선 납기만 — openOnly=false 여도 미완 조건을 건다', async () => {
    const { prisma, calls } = listStub([
      { plant_id: 30n, timezone_code: 'Asia/Ho_Chi_Minh' },
      { plant_id: 31n, timezone_code: 'UTC' },
    ]);
    await new PurchaseOrderLineQueryService(prisma).list({ overdueOnly: true, openOnly: false }, NOW);

    expect(calls.plantWhere).toEqual({});
    expect(calls.findMany?.where).toEqual({
      AND: [
        OPEN,
        {
          purchase_order: {
            OR: [
              { plant_id: 30n, expected_receipt_date: { lt: new Date('2026-10-21T00:00:00.000Z') } },
              { plant_id: 31n, expected_receipt_date: { lt: new Date('2026-10-20T00:00:00.000Z') } },
            ],
          },
        },
      ],
    });
  });

  it('overdueOnly 에 plantId 가 오면 그 공장의 오늘만 구한다', async () => {
    const { prisma, calls } = listStub([{ plant_id: 30n, timezone_code: 'Asia/Ho_Chi_Minh' }]);
    await new PurchaseOrderLineQueryService(prisma).list({ overdueOnly: true, plantId: 30 }, NOW);

    expect(calls.plantWhere).toEqual({ plant_id: 30 });
  });

  it('정렬은 납기 오름차순(없는 것은 뒤) → 발주번호 → 라인번호, 쪽은 pageRequest 로', async () => {
    const { prisma, calls } = listStub();
    await new PurchaseOrderLineQueryService(prisma).list({ page: 3, size: 20 }, NOW);

    expect(calls.findMany).toMatchObject({
      include: { purchase_order: true },
      orderBy: [
        { purchase_order: { expected_receipt_date: { sort: 'asc', nulls: 'last' } } },
        { purchase_order: { purchase_order_no: 'asc' } },
        { line_no: 'asc' },
      ],
      skip: 40,
      take: 20,
    });
  });
});
