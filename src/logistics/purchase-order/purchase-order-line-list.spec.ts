import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { lineListItem, lineListQuery, receiptStatusOf } from './purchase-order-line-list';
import { PurchaseOrderLineListService } from './purchase-order-line-list.service';

type Row = Parameters<typeof lineListItem>[0];

const row = (line: Partial<Row> = {}, order: Partial<Row['purchase_order']> = {}): Row =>
  ({
    purchase_order_line_id: 7n,
    purchase_order_id: 1n,
    line_no: 2,
    item_id: 100n,
    ordered_qty: new Prisma.Decimal('100'),
    uom_id: 5n,
    received_qty: new Prisma.Decimal('0'),
    tolerance_over_qty: new Prisma.Decimal('5'),
    tolerance_under_qty: new Prisma.Decimal('3'),
    erp_storage_location_code: null,
    cancelled_at: null,
    version_no: 1,
    ...line,
    purchase_order: {
      purchase_order_id: 1n,
      purchase_order_no: 'PO-1',
      erp_purchase_order_no: 'ERP-1',
      supplier_id: 10n,
      business_unit_id: 20n,
      plant_id: 30n,
      order_date: new Date('2026-10-01T00:00:00.000Z'),
      expected_receipt_date: new Date('2026-10-25T00:00:00.000Z'),
      status_code: 'REGISTERED',
      ...order,
    },
  }) as Row;

describe('입하 예정 라인 목록 — 질의', () => {
  it('비우면 남은 라인만(openOnly=true) 보고 납기 지남은 거르지 않는다', () => {
    expect(lineListQuery({})).toEqual({ openOnly: true, overdueOnly: false });
  });

  it('가드가 형을 바꾼 값을 옮긴다 — id 는 BigInt · q 는 다듬고 빈 q 는 버린다', () => {
    expect(
      lineListQuery({
        supplierId: 10,
        plantId: 30,
        itemId: 100,
        expectedReceiptDateFrom: '2026-10-01',
        expectedReceiptDateTo: '2026-10-31',
        openOnly: false,
        overdueOnly: true,
        q: '  PO-1 ',
        page: 2,
        size: 20,
      }),
    ).toEqual({
      supplierId: 10n,
      plantId: 30n,
      itemId: 100n,
      expectedReceiptDateFrom: '2026-10-01',
      expectedReceiptDateTo: '2026-10-31',
      openOnly: false,
      overdueOnly: true,
      q: 'PO-1',
      page: 2,
      size: 20,
    });
    expect(lineListQuery({ q: '   ' })).not.toHaveProperty('q');
  });
});

describe('입하 예정 라인 목록 — 입하 진행 판정', () => {
  it('받은 것이 없으면 NOT_STARTED · 일부면 PARTIAL · 발주 수량에 닿으면 COMPLETED', () => {
    expect(receiptStatusOf(row())).toBe('NOT_STARTED');
    expect(receiptStatusOf(row({ received_qty: new Prisma.Decimal('40') }))).toBe('PARTIAL');
    expect(receiptStatusOf(row({ received_qty: new Prisma.Decimal('100') }))).toBe('COMPLETED');
    expect(receiptStatusOf(row({ received_qty: new Prisma.Decimal('104') }))).toBe('COMPLETED');
  });

  it('⛔ 부족 허용치 안이어도 끝난 것이 아니다 — 발주 목록 openOnly 와 같은 기준', () => {
    // 100 중 98 — 부족 허용치 3 안이지만 남은 2 가 있다.
    expect(receiptStatusOf(row({ received_qty: new Prisma.Decimal('98') }))).toBe('PARTIAL');
  });

  it('ERP 가 라인을 취소했거나 헤더가 취소면 CANCELLED 다 — 받은 수량보다 앞선다', () => {
    expect(receiptStatusOf(row({ cancelled_at: new Date('2026-10-10T00:00:00.000Z') }))).toBe('CANCELLED');
    expect(receiptStatusOf(row({ received_qty: new Prisma.Decimal('100') }, { status_code: 'CANCELLED' }))).toBe(
      'CANCELLED',
    );
  });
});

describe('입하 예정 라인 목록 — 행', () => {
  it('발주 헤더 값과 라인 값을 한 행에 싣고 남은 수량을 서버가 센다', () => {
    expect(lineListItem(row({ received_qty: new Prisma.Decimal('40'), erp_storage_location_code: 'S100' }))).toEqual({
      purchaseOrderLineId: 7,
      purchaseOrderId: 1,
      purchaseOrderNo: 'PO-1',
      erpPurchaseOrderNo: 'ERP-1',
      supplierId: 10,
      plantId: 30,
      orderDate: '2026-10-01',
      expectedReceiptDate: '2026-10-25',
      purchaseOrderStatusCode: 'REGISTERED',
      lineNo: 2,
      itemId: 100,
      uomId: 5,
      orderedQty: 100,
      receivedQty: 40,
      remainingQty: 60,
      toleranceOverQty: 5,
      toleranceUnderQty: 3,
      erpStorageLocationCode: 'S100',
      cancelledAt: null,
      receiptStatusCode: 'PARTIAL',
    });
  });

  it('초과 입하면 남은 수량은 0 이다 · 취소 라인도 더 들어올 것이 없어 0 이다', () => {
    expect(lineListItem(row({ received_qty: new Prisma.Decimal('104') })).remainingQty).toBe(0);
    const cancelled = lineListItem(row({ cancelled_at: new Date('2026-10-10T03:00:00.000Z') }));
    expect(cancelled).toMatchObject({ remainingQty: 0, cancelledAt: '2026-10-10T03:00:00.000Z' });
  });

  it('납기가 없는 발주는 null 이다', () => {
    expect(lineListItem(row({}, { expected_receipt_date: null })).expectedReceiptDate).toBeNull();
  });
});

describe('입하 예정 라인 목록 — 거르기', () => {
  const ORDERED_QTY = { modelName: 'purchase_order_line', name: 'ordered_qty' };
  const plants = [
    { plant_id: 30n, timezone_code: 'Asia/Ho_Chi_Minh' },
    { plant_id: 31n, timezone_code: 'Asia/Seoul' },
  ];
  const service = (): { service: PurchaseOrderLineListService; plantWhere: unknown[] } => {
    const plantWhere: unknown[] = [];
    const prisma = {
      purchase_order_line: { fields: { ordered_qty: ORDERED_QTY } },
      plant: {
        findMany: (args: { where: { plant_id?: bigint } }) => {
          plantWhere.push(args.where);
          return Promise.resolve(plants.filter((p) => args.where.plant_id === undefined || p.plant_id === args.where.plant_id));
        },
      },
    } as unknown as PrismaService;
    return { service: new PurchaseOrderLineListService(prisma), plantWhere };
  };

  it('기본(openOnly)은 취소 안 된 남은 라인과 끝나지 않은 헤더만 건다', async () => {
    const where = await service().service.where(lineListQuery({}), new Date());
    expect(where).toEqual({
      cancelled_at: null,
      received_qty: { lt: ORDERED_QTY },
      AND: [{ purchase_order: { is: { status_code: { notIn: ['CLOSED', 'CANCELLED'] } } } }],
    });
  });

  it('openOnly=false 면 라인·헤더 상태를 거르지 않는다', async () => {
    const where = await service().service.where(lineListQuery({ openOnly: false }), new Date());
    expect(where).toEqual({ AND: [{ purchase_order: { is: {} } }] });
  });

  it('q 는 MES 발주번호와 ERP 발주번호 둘 다 본다 · 납기 범위는 날짜 그대로 비교한다', async () => {
    const where = await service().service.where(
      lineListQuery({ openOnly: false, q: 'A1', expectedReceiptDateFrom: '2026-10-01', expectedReceiptDateTo: '2026-10-31' }),
      new Date(),
    );
    expect(where.AND).toEqual([
      {
        purchase_order: {
          is: {
            expected_receipt_date: {
              gte: new Date('2026-10-01T00:00:00.000Z'),
              lte: new Date('2026-10-31T00:00:00.000Z'),
            },
            OR: [
              { purchase_order_no: { contains: 'A1', mode: 'insensitive' } },
              { erp_purchase_order_no: { contains: 'A1', mode: 'insensitive' } },
            ],
          },
        },
      },
    ]);
  });

  it('⭐ 납기 지남은 공장마다 그 현지 오늘로 가른다 — openOnly=false 여도 남은 라인만', async () => {
    // UTC 2026-10-20 16:30 = 하노이 23:30(20일) · 서울 01:30(21일).
    const now = new Date('2026-10-20T16:30:00.000Z');
    const { service: s } = service();
    const where = await s.where(lineListQuery({ openOnly: false, overdueOnly: true }), now);
    expect(where).toMatchObject({ cancelled_at: null, received_qty: { lt: ORDERED_QTY } });
    expect(where.AND).toEqual([
      { purchase_order: { is: { status_code: { notIn: ['CLOSED', 'CANCELLED'] } } } },
      {
        OR: [
          { purchase_order: { is: { plant_id: 30n, expected_receipt_date: { lt: new Date('2026-10-20T00:00:00.000Z') } } } },
          { purchase_order: { is: { plant_id: 31n, expected_receipt_date: { lt: new Date('2026-10-21T00:00:00.000Z') } } } },
        ],
      },
    ]);
  });

  it('공장을 고르면 그 공장의 오늘만 본다', async () => {
    const { service: s, plantWhere } = service();
    const where = await s.where(lineListQuery({ plantId: 31, overdueOnly: true }), new Date('2026-10-20T16:30:00.000Z'));
    expect(plantWhere).toEqual([{ plant_id: 31n }]);
    expect((where.AND as unknown[])[1]).toEqual({
      OR: [{ purchase_order: { is: { plant_id: 31n, expected_receipt_date: { lt: new Date('2026-10-21T00:00:00.000Z') } } } }],
    });
  });
});
