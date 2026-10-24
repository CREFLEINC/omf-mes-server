import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { InboundProgressService } from './inbound-progress.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import { purchaseOrderLineView } from './purchase-order-view';

type Args = Record<string, unknown>;

/** 입하 LOT 이 없는 발주 — 단계 묶음 수는 이 스펙의 관심이 아니다. */
const NO_LOTS = { lotsOf: async () => [] } as unknown as InboundProgressService;

const orderRow = (overrides: Args = {}): Args => ({
  purchase_order_id: 1n,
  purchase_order_no: 'PO-2026-000123',
  erp_purchase_order_no: null,
  supplier_id: 10n,
  business_unit_id: 20n,
  plant_id: 30n,
  order_date: new Date('2026-08-06T00:00:00.000Z'),
  expected_receipt_date: null,
  status_code: 'REGISTERED',
  version_no: 1,
  approval_request_id: null,
  source_inbound_receipt_line_id: null,
  ...overrides,
});

const lineRow = (overrides: Args = {}): Args => ({
  purchase_order_line_id: 1n,
  purchase_order_id: 1n,
  line_no: 1,
  item_id: 100n,
  ordered_qty: new Prisma.Decimal('100'),
  uom_id: 5n,
  received_qty: new Prisma.Decimal('0'),
  tolerance_over_qty: new Prisma.Decimal('0'),
  tolerance_under_qty: new Prisma.Decimal('0'),
  version_no: 1,
  ...overrides,
});

/** 목록이 읽는 모양 — 헤더 + 공급사 + 라인(묶음 값용). */
const listRow = (lines: Args[] = []): Args =>
  orderRow({ partner: { partner_code: 'S-1', partner_name: '공급사' }, purchase_order_line: lines });

const ORDERED_QTY_FIELD_REF = { modelName: 'purchase_order_line', name: 'ordered_qty' }; // Prisma `fields` 참조 스텁

/** `list()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁 — 넘어온 `where` 를 그대로 잡는다. */
function listStub(overrides: { rows?: Args[] } = {}) {
  const calls: { where?: Args } = {};
  const prisma = {
    purchase_order: {
      findMany: async ({ where }: { where: Args }) => {
        calls.where = where;
        return overrides.rows ?? [];
      },
      count: async () => (overrides.rows ?? []).length,
    },
    purchase_order_line: { fields: { ordered_qty: ORDERED_QTY_FIELD_REF } },
    plant: {
      findMany: async () => [
        { plant_id: 30n, timezone_code: 'Asia/Ho_Chi_Minh' },
        { plant_id: 31n, timezone_code: 'Asia/Seoul' },
      ],
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('PurchaseOrderQueryService', () => {
  describe('list', () => {
    it('목록 — openOnly 는 받은 수량이 발주 수량에 못 미치는 라인이 있는 P/O 만 준다', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ openOnly: true }); // tolerance_under_qty 안 뺌(§6-4)

      expect(calls.where?.AND).toEqual([{
        status_code: { notIn: ['CLOSED', 'CANCELLED'] },
        purchase_order_line: { some: { cancelled_at: null, received_qty: { lt: ORDERED_QTY_FIELD_REF } } },
      }]);
    });

    it('목록 — openOnly 를 안 주면 라인 조건을 안 건다', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({});
      expect(calls.where).not.toHaveProperty('AND');
    });

    it('목록 — itemId 는 라인에 그 품목이 있는 P/O 만 준다', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ itemId: 42 });

      expect(calls.where?.AND).toEqual([{ purchase_order_line: { some: { item_id: 42 } } }]);
    });

    it('목록 — itemId 와 openOnly 를 같이 주면 둘 다 건다', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ itemId: 42, openOnly: true });

      // 스프레드로 합치면 뒤(openOnly)가 앞(itemId)을 덮어쓴다 — AND 로 둘 다 걸려야 한다.
      expect(calls.where?.AND).toEqual([
        { purchase_order_line: { some: { item_id: 42 } } },
        { status_code: { notIn: ['CLOSED', 'CANCELLED'] },
          purchase_order_line: { some: { cancelled_at: null, received_qty: { lt: ORDERED_QTY_FIELD_REF } } } },
      ]);
    });

    it('목록 — orderDateFrom/To 는 날짜 그대로 비교한다(타임존 캐스팅 없음)', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ orderDateFrom: '2026-08-01', orderDateTo: '2026-08-31' });

      expect(calls.where?.order_date).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lte: new Date('2026-08-31T00:00:00.000Z'),
      });
    });

    it('목록 — 기간 없이도 조회된다(기간 필수가 아니다)', async () => {
      const { prisma, calls } = listStub({ rows: [listRow()] });
      const result = await new PurchaseOrderQueryService(prisma, NO_LOTS).list({});

      expect(result.items).toHaveLength(1);
      expect(calls.where).not.toHaveProperty('order_date');
    });

    it('⭐ 목록 행에 공급사 코드·이름과 라인 묶음 값을 싣는다 · itemId 로 찾으면 그 품목 라인 수도', async () => {
      const qty = (value: string) => new Prisma.Decimal(value);
      const lines = [
        { item_id: 42n, uom_id: 5n, ordered_qty: qty('100'), received_qty: qty('40'), cancelled_at: null, uom: { uom_code: 'KG' } },
        { item_id: 43n, uom_id: 5n, ordered_qty: qty('50'), received_qty: qty('0'), cancelled_at: null, uom: { uom_code: 'KG' } },
      ];
      const { prisma } = listStub({ rows: [listRow(lines)] });
      const result = await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ itemId: 42 });

      expect(result.items[0]).toMatchObject({
        purchaseOrderId: 1,
        supplierCode: 'S-1',
        supplierName: '공급사',
        lineCount: 2,
        openLineCount: 2,
        matchedLineCount: 1,
        uomId: 5,
        uomCode: 'KG',
        orderedQtyTotal: 150,
        receivedQtyTotal: 40,
        remainingQtyTotal: 110,
        receiptStatusCode: 'PARTIAL',
      });
      const plain = await new PurchaseOrderQueryService(listStub({ rows: [listRow(lines)] }).prisma, NO_LOTS).list({});
      expect(plain.items[0]).toMatchObject({ matchedLineCount: null });
    });

    it('목록 — 납기 범위는 날짜 그대로 비교한다 · 공급사 검색은 코드·이름 부분 일치다', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({
        expectedReceiptDateFrom: '2026-10-20',
        expectedReceiptDateTo: '2026-10-20',
        supplierQ: ' 하노이 ',
      });

      expect(calls.where?.expected_receipt_date).toEqual({
        gte: new Date('2026-10-20T00:00:00.000Z'),
        lte: new Date('2026-10-20T00:00:00.000Z'),
      });
      expect(calls.where?.AND).toEqual([
        {
          partner: {
            OR: [
              { partner_code: { contains: '하노이', mode: 'insensitive' } },
              { partner_name: { contains: '하노이', mode: 'insensitive' } },
            ],
          },
        },
      ]);
    });

    it('⭐ overdueOnly 는 남은 P/O 조건과 공장별 현지 오늘 앞의 납기를 함께 건다', async () => {
      const { prisma, calls } = listStub();
      // UTC 2026-10-20 16:30 = 하노이 23:30(20일) · 서울 01:30(21일).
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ overdueOnly: true }, new Date('2026-10-20T16:30:00.000Z'));

      expect(calls.where?.AND).toEqual([
        { status_code: { notIn: ['CLOSED', 'CANCELLED'] },
          purchase_order_line: { some: { cancelled_at: null, received_qty: { lt: ORDERED_QTY_FIELD_REF } } } },
        {
          OR: [
            { plant_id: 30n, expected_receipt_date: { lt: new Date('2026-10-20T00:00:00.000Z') } },
            { plant_id: 31n, expected_receipt_date: { lt: new Date('2026-10-21T00:00:00.000Z') } },
          ],
        },
      ]);
    });

    it('목록 — q 는 MES 발주번호만 검색한다(ERP 번호는 안 본다)', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderQueryService(prisma, NO_LOTS).list({ q: 'PO-2026' });

      expect(calls.where?.purchase_order_no).toEqual({ contains: 'PO-2026', mode: 'insensitive' });
      expect(calls.where).not.toHaveProperty('erp_purchase_order_no');
    });
  });

  describe('입고 단계 묶음(장부 P-110)', () => {
    /** 발주 id 와 LOT 단계 — 판정은 `inbound-stage.spec.ts` 가 본다. */
    const lots = (rows: [bigint, string][]): InboundProgressService =>
      ({
        lotsOf: async (ids: bigint[]) =>
          rows.filter(([id]) => ids.includes(id)).map(([purchaseOrderId, stageCode]) => ({ purchaseOrderId, progress: { stageCode } })),
      }) as unknown as InboundProgressService;
    const orders = [1n, 2n, 3n].map((id) => ({ ...listRow(), purchase_order_id: id }));
    const STAGES: [bigint, string][] = [
      [1n, 'LABEL_PENDING'],
      [1n, 'INSPECTION_REQUESTED'],
      [1n, 'RECEIPT_READY'],
      [1n, 'RECEIPT_READY'],
      [1n, 'COMPLETED'],
      [2n, 'INSPECTION_HELD'],
      [2n, 'PUTAWAY_TEMPORARY'],
      [2n, 'CANCELLED'],
    ];

    it('⭐ 행마다 그 발주 LOT 의 묶음 수를 싣는다 — 완료·취소는 세지 않고 LOT 이 없으면 {}', async () => {
      const { prisma } = listStub({ rows: orders });
      const result = await new PurchaseOrderQueryService(prisma, lots(STAGES)).list({});

      expect(result.items.map((item) => item.inboundStageCounts)).toEqual([
        { LABEL: 1, INSPECTION: 1, RECEIPT: 2 },
        { HELD: 1, PUTAWAY: 1 },
        {},
      ]);
    });

    it('⭐ inboundStage 로 거르면 조건 전체를 판정한 뒤 그 묶음 LOT 이 있는 발주 id 로 좁힌다', async () => {
      const { prisma, calls } = listStub({ rows: orders });
      await new PurchaseOrderQueryService(prisma, lots(STAGES)).list({ inboundStage: 'PUTAWAY' });

      expect(calls.where).toEqual({ purchase_order_id: { in: [2n] } });
    });

    it('⭐ 칩의 수는 조건 전체를 묶음별로 더한다 — 0 인 묶음도 싣는다', async () => {
      const { prisma } = listStub({ rows: orders });
      const counts = await new PurchaseOrderQueryService(prisma, lots(STAGES)).inboundStageCounts({ inboundStage: 'HELD' });

      expect(counts).toEqual({ LABEL: 1, INSPECTION: 1, HELD: 1, RECEIPT: 2, PUTAWAY: 1 });
    });
  });

  describe('get', () => {
    it('상세 — 헤더와 라인을 함께 준다(lineNo 오름차순)', async () => {
      const orderByCalls: Args[] = [];
      const prisma = {
        purchase_order: { findUnique: async () => orderRow() },
        purchase_order_line: {
          findMany: async ({ orderBy }: { orderBy: Args }) => {
            orderByCalls.push(orderBy);
            return [lineRow({ line_no: 1 }), lineRow({ line_no: 2, purchase_order_line_id: 2n })];
          },
        },
      } as unknown as PrismaService;

      const { detail, versionNo } = await new PurchaseOrderQueryService(prisma, NO_LOTS).get(1);

      expect(detail.purchaseOrder.purchaseOrderId).toBe(1);
      expect(detail.lines.map((line) => line.lineNo)).toEqual([1, 2]);
      expect(orderByCalls[0]).toEqual({ line_no: 'asc' });
      expect(versionNo).toBe(1);
    });
  });

  describe('매퍼', () => {
    it('매퍼 — orderedQty 는 number 다(Decimal 을 그대로 내리지 않는다)', () => {
      const view = purchaseOrderLineView(lineRow({ ordered_qty: new Prisma.Decimal('100.500000') }) as never);

      expect(view.orderedQty).toBe(100.5);
      expect(typeof view.orderedQty).toBe('number');
    });

    it('매퍼 — 비어 있는 erpPurchaseOrderNo·approvalRequestId 는 널이다(키를 생략하지 않는다)', async () => {
      const prisma = {
        purchase_order: { findUnique: async () => orderRow({ erp_purchase_order_no: null, approval_request_id: null }) },
        purchase_order_line: { findMany: async () => [] },
      } as unknown as PrismaService;

      const { detail } = await new PurchaseOrderQueryService(prisma, NO_LOTS).get(1);

      expect(detail.purchaseOrder).toMatchObject({ erpPurchaseOrderNo: null, approvalRequestId: null });
    });

    it('매퍼 — 생략된 tolerance*Qty 는 0 이다(널이 아니다)', () => {
      const row = lineRow({ tolerance_over_qty: new Prisma.Decimal(0), tolerance_under_qty: new Prisma.Decimal(0) });
      expect(purchaseOrderLineView(row as never)).toMatchObject({ toleranceOverQty: 0, toleranceUnderQty: 0 });
    });
  });
});
