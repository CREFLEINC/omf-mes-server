import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { purchaseOrderLineView } from './purchase-order-view';
import { PurchaseOrderService } from './purchase-order.service';

type Args = Record<string, unknown>;

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
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('PurchaseOrderService', () => {
  describe('list', () => {
    it('목록 — openOnly 는 받은 수량이 발주 수량에 못 미치는 라인이 있는 P/O 만 준다', async () => {
      const { prisma, calls } = listStub();

      await new PurchaseOrderService(prisma).list({ openOnly: true }); // tolerance_under_qty 안 뺌(§6-4)

      expect(calls.where?.purchase_order_line).toEqual({ some: { received_qty: { lt: ORDERED_QTY_FIELD_REF } } });
    });

    it('목록 — openOnly 를 안 주면 라인 조건을 안 건다', async () => {
      const { prisma, calls } = listStub();
      await new PurchaseOrderService(prisma).list({});
      expect(calls.where).not.toHaveProperty('purchase_order_line');
    });

    it('목록 — itemId 는 라인에 그 품목이 있는 P/O 만 준다', async () => {
      const { prisma, calls } = listStub();
      const service = new PurchaseOrderService(prisma);

      await service.list({ itemId: 42 });

      expect(calls.where?.purchase_order_line).toEqual({ some: { item_id: 42 } });
    });

    it('목록 — orderDateFrom/To 는 날짜 그대로 비교한다(타임존 캐스팅 없음)', async () => {
      const { prisma, calls } = listStub();
      const service = new PurchaseOrderService(prisma);

      await service.list({ orderDateFrom: '2026-08-01', orderDateTo: '2026-08-31' });

      expect(calls.where?.order_date).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lte: new Date('2026-08-31T00:00:00.000Z'),
      });
    });

    it('목록 — 기간 없이도 조회된다(기간 필수가 아니다)', async () => {
      const { prisma, calls } = listStub({ rows: [orderRow()] });
      const service = new PurchaseOrderService(prisma);

      const result = await service.list({});

      expect(result.items).toHaveLength(1);
      expect(calls.where).not.toHaveProperty('order_date');
    });

    it('목록 — q 는 MES 발주번호만 검색한다(ERP 번호는 안 본다)', async () => {
      const { prisma, calls } = listStub();
      const service = new PurchaseOrderService(prisma);

      await service.list({ q: 'PO-2026' });

      expect(calls.where?.purchase_order_no).toEqual({ contains: 'PO-2026', mode: 'insensitive' });
      expect(calls.where).not.toHaveProperty('erp_purchase_order_no');
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

      const { detail, versionNo } = await new PurchaseOrderService(prisma).get(1);

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

      const { detail } = await new PurchaseOrderService(prisma).get(1);

      expect(detail.purchaseOrder).toHaveProperty('erpPurchaseOrderNo', null);
      expect(detail.purchaseOrder).toHaveProperty('approvalRequestId', null);
    });

    it('매퍼 — 생략된 tolerance*Qty 는 0 이다(널이 아니다)', () => {
      const view = purchaseOrderLineView(
        lineRow({ tolerance_over_qty: new Prisma.Decimal(0), tolerance_under_qty: new Prisma.Decimal(0) }) as never,
      );

      expect(view.toleranceOverQty).toBe(0);
      expect(view.toleranceUnderQty).toBe(0);
    });
  });
});
