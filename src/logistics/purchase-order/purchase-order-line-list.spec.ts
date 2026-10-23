import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { lineListItem, parseLineListQuery, parseOrderListExtras } from './purchase-order-line-list';
import { PurchaseOrderLineListService } from './purchase-order-line-list.service';
import { lineReceiptStatus, orderReceiptSummary } from './purchase-order-receipt';

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
    item: { item_code: 'RM-1', item_name: '판재' },
    uom: { uom_code: 'KG', uom_name: '킬로그램' },
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
      partner: { partner_code: 'S-1', partner_name: '공급사' },
      ...order,
    },
  }) as Row;

function errorsOf(raw: Record<string, unknown>): unknown {
  try {
    parseLineListQuery(raw);
  } catch (error) {
    if (error instanceof ContractException) return (error.getResponse() as { errors: unknown }).errors;
    throw error;
  }
  throw new Error('400 이 나야 한다');
}

describe('입하 예정 라인 목록 — 질의', () => {
  it('비우면 남은 라인만(openOnly=true) 보고 납기 지남은 거르지 않는다', () => {
    expect(parseLineListQuery({})).toEqual({ openOnly: true, overdueOnly: false });
  });

  it('값을 받아 형에 맞춰 옮긴다 · q 는 다듬고 빈 q 는 버린다', () => {
    expect(
      parseLineListQuery({
        purchaseOrderId: '9',
        supplierId: '10',
        plantId: '30',
        itemId: '100',
        expectedReceiptDateFrom: '2026-10-01',
        expectedReceiptDateTo: '2026-10-31',
        openOnly: 'false',
        overdueOnly: 'true',
        q: '  PO-1 ',
        page: '2',
        size: '20',
      }),
    ).toEqual({
      purchaseOrderId: 9n,
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
    expect(parseLineListQuery({ q: '   ' })).not.toHaveProperty('q');
  });

  it('⛔ 틀린 값은 칸마다 400 INVALID 로 모아 낸다 — 없는 날(2026-02-30)도 막는다', () => {
    expect(
      errorsOf({ plantId: '0', expectedReceiptDateTo: '2026-02-30', openOnly: 'yes', page: '-1', itemId: ['1', '2'] }),
    ).toEqual([
      expect.objectContaining({ field: 'plantId', code: 'INVALID' }),
      expect.objectContaining({ field: 'itemId', code: 'INVALID' }),
      expect.objectContaining({ field: 'expectedReceiptDateTo', code: 'INVALID' }),
      expect.objectContaining({ field: 'openOnly', code: 'INVALID' }),
      expect.objectContaining({ field: 'page', code: 'INVALID' }),
    ]);
  });

  it('⛔ int64 를 넘는 id 는 400 이다 — Prisma 까지 가면 500 이 된다', () => {
    expect(errorsOf({ supplierId: '9223372036854775808' })).toEqual([
      expect.objectContaining({ field: 'supplierId', code: 'INVALID' }),
    ]);
  });
});

const receiptStatusOf = (r: Row) => lineReceiptStatus(r, r.purchase_order.status_code);

describe('P/O 목록 — 계약 밖 조건(P-85)', () => {
  it('문자열로 온 납기 범위·지연만·공급사 검색을 형에 맞춰 옮기고, 없으면 키를 undefined 로 싣는다', () => {
    expect(
      parseOrderListExtras({
        expectedReceiptDateFrom: '2026-10-20',
        expectedReceiptDateTo: '2026-10-20',
        overdueOnly: 'true',
        supplierQ: ' 하노이 ',
      }),
    ).toEqual({
      expectedReceiptDateFrom: '2026-10-20',
      expectedReceiptDateTo: '2026-10-20',
      overdueOnly: true,
      supplierQ: '하노이',
    });
    expect(parseOrderListExtras({ supplierQ: '  ' })).toEqual({
      expectedReceiptDateFrom: undefined,
      expectedReceiptDateTo: undefined,
      overdueOnly: undefined,
      supplierQ: undefined,
    });
  });

  it('⛔ 틀린 값은 칸마다 400 INVALID 다', () => {
    let errors: unknown;
    try {
      parseOrderListExtras({ expectedReceiptDateFrom: '2026-02-30', overdueOnly: 'yes', supplierQ: ['a'] });
    } catch (error) {
      errors = ((error as ContractException).getResponse() as { errors: unknown }).errors;
    }
    expect(errors).toEqual([
      expect.objectContaining({ field: 'expectedReceiptDateFrom', code: 'INVALID' }),
      expect.objectContaining({ field: 'overdueOnly', code: 'INVALID' }),
      expect.objectContaining({ field: 'supplierQ', code: 'INVALID' }),
    ]);
  });

  it('inboundStage 는 네 묶음 중 하나다 — 밖이면 400 INVALID(장부 P-110)', () => {
    expect(parseOrderListExtras({ inboundStage: 'HELD' }).inboundStage).toBe('HELD');
    let errors: unknown;
    try {
      parseOrderListExtras({ inboundStage: 'COMPLETED' });
    } catch (error) {
      errors = ((error as ContractException).getResponse() as { errors: unknown }).errors;
    }
    expect(errors).toEqual([expect.objectContaining({ field: 'inboundStage', code: 'INVALID' })]);
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
      supplierCode: 'S-1',
      supplierName: '공급사',
      plantId: 30,
      orderDate: '2026-10-01',
      expectedReceiptDate: '2026-10-25',
      purchaseOrderStatusCode: 'REGISTERED',
      lineNo: 2,
      itemId: 100,
      itemCode: 'RM-1',
      itemName: '판재',
      uomId: 5,
      uomCode: 'KG',
      uomName: '킬로그램',
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
    const where = await service().service.where(parseLineListQuery({}), new Date());
    expect(where).toEqual({
      cancelled_at: null,
      received_qty: { lt: ORDERED_QTY },
      AND: [{ purchase_order: { is: { status_code: { notIn: ['CLOSED', 'CANCELLED'] } } } }],
    });
  });

  it('openOnly=false 면 라인·헤더 상태를 거르지 않는다', async () => {
    const where = await service().service.where(parseLineListQuery({ openOnly: 'false' }), new Date());
    expect(where).toEqual({ AND: [{ purchase_order: { is: {} } }] });
  });

  it('q 는 MES 발주번호와 ERP 발주번호 둘 다 본다 · 납기 범위는 날짜 그대로 비교한다', async () => {
    const where = await service().service.where(
      parseLineListQuery({ openOnly: 'false', q: 'A1', expectedReceiptDateFrom: '2026-10-01', expectedReceiptDateTo: '2026-10-31' }),
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
    const where = await s.where(parseLineListQuery({ openOnly: 'false', overdueOnly: 'true' }), now);
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

  it('purchaseOrderId 를 주면 그 P/O 의 라인만 건다', async () => {
    const where = await service().service.where(parseLineListQuery({ purchaseOrderId: '9', openOnly: 'false' }), new Date());
    expect(where).toEqual({ purchase_order_id: 9n, AND: [{ purchase_order: { is: {} } }] });
  });

  it('공장을 고르면 그 공장의 오늘만 본다', async () => {
    const { service: s, plantWhere } = service();
    const where = await s.where(parseLineListQuery({ plantId: '31', overdueOnly: 'true' }), new Date('2026-10-20T16:30:00.000Z'));
    expect(plantWhere).toEqual([{ plant_id: 31n }]);
    expect((where.AND as unknown[])[1]).toEqual({
      OR: [{ purchase_order: { is: { plant_id: 31n, expected_receipt_date: { lt: new Date('2026-10-21T00:00:00.000Z') } } } }],
    });
  });
});

describe('P/O 묶음 값', () => {
  const line = (ordered: string, received: string, uomId = 5n, cancelled = false) => ({
    ordered_qty: new Prisma.Decimal(ordered),
    received_qty: new Prisma.Decimal(received),
    cancelled_at: cancelled ? new Date('2026-10-10T00:00:00.000Z') : null,
    uom_id: uomId,
    uom: { uom_code: uomId === 5n ? 'KG' : 'EA' },
  });

  it('취소되지 않은 라인만 더한다 · 남은 수량은 라인마다 0 아래를 자른 뒤 더한다', () => {
    expect(orderReceiptSummary('REGISTERED', [line('100', '104'), line('50', '20'), line('30', '0', 5n, true)])).toEqual({
      lineCount: 3,
      openLineCount: 1,
      uomId: 5,
      uomCode: 'KG',
      orderedQtyTotal: 150,
      receivedQtyTotal: 124,
      remainingQtyTotal: 30,
      receiptStatusCode: 'PARTIAL',
    });
  });

  it('⭐ 단위가 섞이면 합계와 단위를 모두 비운다 — 취소된 라인의 단위는 세지 않는다', () => {
    expect(orderReceiptSummary('REGISTERED', [line('10', '0'), line('5', '0', 6n)])).toMatchObject({
      uomId: null,
      uomCode: null,
      orderedQtyTotal: null,
      receivedQtyTotal: null,
      remainingQtyTotal: null,
    });
    expect(orderReceiptSummary('REGISTERED', [line('10', '0'), line('5', '0', 6n, true)])).toMatchObject({
      uomId: 5,
      orderedQtyTotal: 10,
    });
  });

  it('진행: 다 들어오면 COMPLETED · 하나도 없으면 NOT_STARTED · 라인이 없어도 NOT_STARTED', () => {
    expect(orderReceiptSummary('REGISTERED', [line('10', '10'), line('5', '0', 5n, true)]).receiptStatusCode).toBe(
      'COMPLETED',
    );
    expect(orderReceiptSummary('REGISTERED', [line('10', '0'), line('5', '0')]).receiptStatusCode).toBe('NOT_STARTED');
    expect(orderReceiptSummary('REGISTERED', [])).toMatchObject({
      lineCount: 0,
      uomId: null,
      orderedQtyTotal: null,
      receiptStatusCode: 'NOT_STARTED',
    });
  });

  it('헤더가 취소됐거나 모든 라인이 취소면 CANCELLED 이고 남은 라인은 없다', () => {
    expect(orderReceiptSummary('CANCELLED', [line('10', '0')])).toMatchObject({
      receiptStatusCode: 'CANCELLED',
      openLineCount: 0,
      remainingQtyTotal: 0,
    });
    expect(orderReceiptSummary('REGISTERED', [line('10', '0', 5n, true)]).receiptStatusCode).toBe('CANCELLED');
  });
});
