import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { InboundReceiptLineView, inboundReceiptLineView } from './inbound-receipt-view';
import { InboundReceiptQueryService } from './inbound-receipt-query.service';
import { InboundVarianceService } from './inbound-variance.service';

type Args = Record<string, unknown>;

const lineRow = (overrides: Args = {}): Args => ({
  inbound_receipt_line_id: 1n,
  inbound_receipt_id: 1n,
  line_no: 1,
  purchase_order_line_id: null,
  asn_line_id: null,
  item_id: 40n,
  received_qty: new Prisma.Decimal('10.500000'),
  uom_id: 50n,
  package_count: null,
  supplier_lot_no: null,
  supplier_lot_missing: true,
  substitute_lot_reason_code: null,
  manufactured_date: null,
  expiry_date: null,
  inspection_required: false,
  status_code: 'REGISTERED',
  lot_id: null,
  ...overrides,
});

/** `list()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁 — 넘어온 `where` 를 그대로 잡는다. */
function listStub(overrides: { rows?: Args[] } = {}) {
  const calls: { where?: Args } = {};
  const prisma = {
    inbound_receipt: {
      findMany: async ({ where }: { where: Args }) => {
        calls.where = where;
        return overrides.rows ?? [];
      },
      count: async () => (overrides.rows ?? []).length,
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

function linesStub(overrides: { rows?: Args[] } = {}) {
  const calls: { where?: Args } = {};
  const prisma = {
    inbound_receipt_line: {
      findMany: async ({ where }: { where: Args }) => {
        calls.where = where;
        return overrides.rows ?? [];
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('InboundReceiptQueryService', () => {
  describe('list', () => {
    it('목록 — receiptDate 는 timestamptz 라 UTC 경계로 자른다(공장 없이 로컬 경계를 못 푼다 — 입고 선례)', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({
        receiptDateFrom: '2026-08-01',
        receiptDateTo: '2026-08-31',
      });

      expect(calls.where?.receipt_datetime).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lt: new Date('2026-09-01T00:00:00.000Z'), // 「To」는 다음날 00:00Z 미만(반열림)이다.
      });
    });

    it('목록 — supplierLotMissing 은 그런 라인을 하나 이상 가진 건만 준다(헤더 목록인데 판정은 라인 단위)', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({ supplierLotMissing: true });

      expect(calls.where?.AND).toEqual([
        { inbound_receipt_line: { some: { supplier_lot_missing: true } } },
      ]);
    });

    it('목록 — labelIssued 는 라인의 LOT 에 MATERIAL_LOT_LABEL 발행 기록이 있는가로 가른다', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({ labelIssued: true });

      expect(calls.where?.AND).toEqual([
        {
          inbound_receipt_line: {
            some: { lot: { document_issue_log: { some: { document_type_code: 'MATERIAL_LOT_LABEL' } } } },
          },
        },
      ]);
    });

    it('목록 — labelIssued=false 는 lotId 가 빈 라인도 포함한다(발행될 수 없으므로 미발행이다)', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({ labelIssued: false });

      // `none` 은 `some` 의 부정이다 — `lot` 이 없는 라인도 조건을 만족(참)한다.
      expect(calls.where?.AND).toEqual([
        {
          inbound_receipt_line: {
            none: { lot: { document_issue_log: { some: { document_type_code: 'MATERIAL_LOT_LABEL' } } } },
          },
        },
      ]);
    });

    it('목록 — supplierLotMissing 과 labelIssued 를 같이 주면 둘 다 AND 로 건다(스프레드로 덮지 않는다)', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({ supplierLotMissing: true, labelIssued: false });

      expect(calls.where?.AND).toEqual([
        { inbound_receipt_line: { some: { supplier_lot_missing: true } } },
        {
          inbound_receipt_line: {
            none: { lot: { document_issue_log: { some: { document_type_code: 'MATERIAL_LOT_LABEL' } } } },
          },
        },
      ]);
    });

    it('목록 — q 는 inboundReceiptNo 와 deliveryNoteNo 둘을 본다', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({ q: 'IR-2026' });

      expect(calls.where?.OR).toEqual([
        { inbound_receipt_no: { contains: 'IR-2026', mode: 'insensitive' } },
        { delivery_note_no: { contains: 'IR-2026', mode: 'insensitive' } },
      ]);
    });

    it('목록 — statusCode 는 값 목록 검사를 하지 않는다', async () => {
      const { prisma, calls } = listStub();
      await new InboundReceiptQueryService(prisma).list({ statusCode: 'ANY_VALUE' });

      expect(calls.where?.status_code).toBe('ANY_VALUE');
    });
  });

  describe('lines', () => {
    it('라인 목록 — supplierLotMissing·labelIssued 두 필터가 AND 로 합쳐진다(스프레드로 덮지 않는다)', async () => {
      const { prisma, calls } = linesStub();
      await new InboundReceiptQueryService(prisma).lines(1, { supplierLotMissing: true, labelIssued: false });

      expect(calls.where?.AND).toEqual([
        { supplier_lot_missing: true },
        { NOT: { lot: { document_issue_log: { some: { document_type_code: 'MATERIAL_LOT_LABEL' } } } } },
      ]);
    });
  });

  describe('매퍼', () => {
    it('매퍼 — receivedQty 는 number 다', () => {
      const view: InboundReceiptLineView = inboundReceiptLineView(lineRow() as never);

      expect(view.receivedQty).toBe(10.5);
      expect(typeof view.receivedQty).toBe('number');
    });

    it('매퍼 — 비어 있는 lotId·purchaseOrderLineId 는 널이다(키를 생략하지 않는다)', () => {
      const view = inboundReceiptLineView(lineRow({ lot_id: null, purchase_order_line_id: null }) as never);

      expect(view).toHaveProperty('lotId', null);
      expect(view).toHaveProperty('purchaseOrderLineId', null);
    });
  });

  describe('InboundVarianceService', () => {
    it('차이 목록 — 없는 라인이면 빈 배열이다(404 가 아니다)', async () => {
      const prisma = {
        inbound_variance: { findMany: async () => [] },
      } as unknown as PrismaService;

      const result = await new InboundVarianceService(prisma).list(999999999);

      expect(result).toEqual([]);
    });
  });
});
