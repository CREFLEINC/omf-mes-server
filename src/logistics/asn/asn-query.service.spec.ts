import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AsnQueryService } from './asn-query.service';
import { asnLineView } from './asn-view';

type Args = Record<string, unknown>;

const asnRow = (overrides: Args = {}): Args => ({
  asn_id: 1n,
  asn_no: 'ASN-2026-000045',
  supplier_id: 10n,
  plant_id: 30n,
  expected_arrival_date: new Date('2026-08-06T00:00:00.000Z'),
  delivery_note_no: null,
  status_code: 'EXPECTED',
  remarks: null,
  version_no: 1,
  ...overrides,
});

const asnLineRow = (overrides: Args = {}): Args => ({
  asn_line_id: 1n,
  asn_id: 1n,
  line_no: 1,
  purchase_order_line_id: null,
  item_id: 100n,
  expected_qty: new Prisma.Decimal('100'),
  uom_id: 5n,
  supplier_lot_no: null,
  purchase_order_line: null,
  ...overrides,
});

/** `list()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁 — 넘어온 `where` 를 그대로 잡는다. */
function listStub(overrides: { rows?: Args[] } = {}) {
  const calls: { where?: Args } = {};
  const prisma = {
    asn: {
      findMany: async ({ where }: { where: Args }) => {
        calls.where = where;
        return overrides.rows ?? [];
      },
      count: async () => (overrides.rows ?? []).length,
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

describe('AsnQueryService', () => {
  describe('list', () => {
    it('ASN 목록 — 기본 정렬이 도착 예정일 오름차순이다(계약이 적은 유일한 정렬)', async () => {
      const orderByCalls: Args[] = [];
      const prisma = {
        asn: {
          findMany: async ({ orderBy }: { orderBy: Args }) => {
            orderByCalls.push(orderBy as Args);
            return [];
          },
          count: async () => 0,
        },
      } as unknown as PrismaService;

      await new AsnQueryService(prisma).list({});

      expect(orderByCalls[0]).toEqual([{ expected_arrival_date: 'asc' }, { asn_id: 'asc' }]);
    });

    it('ASN 목록 — expectedArrivalDate 는 @db.Date 라 타임존 캐스팅 없이 비교한다', async () => {
      const { prisma, calls } = listStub({ rows: [asnRow()] });
      await new AsnQueryService(prisma).list({
        expectedArrivalDateFrom: '2026-08-01',
        expectedArrivalDateTo: '2026-08-31',
      });

      expect(calls.where?.expected_arrival_date).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lte: new Date('2026-08-31T00:00:00.000Z'),
      });
    });

    it('ASN 목록 — itemId 는 라인에 그 품목이 있는 건만 준다', async () => {
      const { prisma, calls } = listStub();
      await new AsnQueryService(prisma).list({ itemId: 42 });

      expect(calls.where?.asn_line).toEqual({ some: { item_id: 42 } });
    });

    it('ASN 목록 — q 는 asnNo 와 deliveryNoteNo 둘을 본다(계약이 둘을 적었다)', async () => {
      const { prisma, calls } = listStub();
      await new AsnQueryService(prisma).list({ q: 'ASN-2026' });

      expect(calls.where?.OR).toEqual([
        { asn_no: { contains: 'ASN-2026', mode: 'insensitive' } },
        { delivery_note_no: { contains: 'ASN-2026', mode: 'insensitive' } },
      ]);
    });

    it('ASN 목록 — statusCode 는 값 목록 검사를 하지 않는다(코드 그룹이 없다)', async () => {
      const { prisma, calls } = listStub();
      await new AsnQueryService(prisma).list({ statusCode: '아무값이나' });

      expect(calls.where?.status_code).toBe('아무값이나');
    });
  });

  describe('lines', () => {
    it('ASN 라인 — orderedQty·receivedQty 는 purchase_order_line 조인 파생이다', async () => {
      const prisma = {
        asn_line: {
          findMany: async () => [
            asnLineRow({
              purchase_order_line_id: 500n,
              purchase_order_line: {
                ordered_qty: new Prisma.Decimal('500'),
                received_qty: new Prisma.Decimal('120'),
              },
            }),
          ],
        },
      } as unknown as PrismaService;

      const [line] = await new AsnQueryService(prisma).lines(1);

      expect(line.orderedQty).toBe(500);
      expect(line.receivedQty).toBe(120);
    });

    it('ASN 라인 — purchaseOrderLineId 가 비면 orderedQty·receivedQty 가 널이다(무발주)', async () => {
      const prisma = {
        asn_line: { findMany: async () => [asnLineRow()] },
      } as unknown as PrismaService;

      const [line] = await new AsnQueryService(prisma).lines(1);

      expect(line.purchaseOrderLineId).toBeNull();
      expect(line.orderedQty).toBeNull();
      expect(line.receivedQty).toBeNull();
    });

    it('ASN 라인 — lineNo 오름차순이다', async () => {
      const orderByCalls: Args[] = [];
      const prisma = {
        asn_line: {
          findMany: async ({ orderBy }: { orderBy: Args }) => {
            orderByCalls.push(orderBy as Args);
            return [];
          },
        },
      } as unknown as PrismaService;

      await new AsnQueryService(prisma).lines(1);

      expect(orderByCalls[0]).toEqual({ line_no: 'asc' });
    });
  });

  describe('매퍼', () => {
    it('매퍼 — expectedQty 는 number 다(Decimal 을 그대로 내리지 않는다)', () => {
      const view = asnLineView(asnLineRow({ expected_qty: new Prisma.Decimal('100.500000') }) as never);

      expect(view.expectedQty).toBe(100.5);
      expect(typeof view.expectedQty).toBe('number');
    });
  });
});
