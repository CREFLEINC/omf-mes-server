import { Prisma } from '@prisma/client';

import { LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { LotCreate, LotService } from './lot.service';

type Args = Record<string, unknown>;

const source = {
  inbound_receipt_line_id: 77n,
  inbound_receipt_id: 88n,
  line_no: 1,
  purchase_order_line_id: 99n,
  asn_line_id: null,
  item_id: 9270n,
  received_qty: new Prisma.Decimal(100),
  uom_id: 8401n,
  package_count: null,
  supplier_lot_no: '납품서-LOT/A-01',
  supplier_lot_missing: false,
  supplier_lot_label_attached: false,
  substitute_lot_reason_code: null,
  manufactured_date: null,
  expiry_date: null,
  inspection_required: true,
  status_code: 'REGISTERED',
  created_at: new Date(),
  created_by: 1n,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
  lot_id: null,
  inbound_receipt: {
    inbound_receipt_id: 88n,
    supplier_id: 19n,
    plant_id: 1n,
  },
};

const input = (overrides: Partial<LotCreate> = {}): LotCreate => ({
  numberSourceCode: 'MES',
  itemId: 9270,
  lotTypeCode: 'MATERIAL',
  plantId: 1,
  initialQty: 100,
  uomId: 8401,
  sourceTypeCode: 'INBOUND_RECEIPT_LINE',
  sourceId: 77,
  businessDate: '2026-09-11',
  occurredAt: '2026-09-11T08:00:00+07:00',
  ...overrides,
});

function fake() {
  const recorded = {
    register: undefined as Args | undefined,
    numbering: [] as unknown[][],
  };
  const tx = {
    inbound_receipt_line: { findUnique: async () => source },
    item: { findUnique: async () => ({ item_code: '990020001' }) },
    partner: { findUnique: async () => ({ partner_code: '100019' }) },
    lot: {
      findMany: async () => [{ lot_no: '9900200010000001002609111000190009' }],
    },
  };
  const prisma = {
    inbound_receipt_line: { findUnique: async () => source },
    code_value: {
      findMany: async ({ where }: { where: { OR: Args[] } }) =>
        where.OR.map((check) => ({
          code: check.code,
          code_group: { group_code: (check.code_group as Args).group_code },
        })),
    },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
  };
  const registry = {
    createWithin: async (_tx: unknown, register: Args) => {
      recorded.register = register;
      return { lot_id: 7000n };
    },
  };
  const numbering = {
    next: async (...args: unknown[]) => {
      recorded.numbering.push(args);
      return 'IRQ-20260911-0001';
    },
  };
  const service = new LotService(
    prisma as unknown as PrismaService,
    registry as unknown as LotRegistryService,
    numbering as unknown as NumberingService,
  );
  jest.spyOn(service, 'get').mockResolvedValue({
    detail: { lot: {} as never, externalIdentifiers: [], holds: [] },
    versionNo: 1,
  });
  return { service, recorded };
}

describe('LotService.create — 입하 MES 자재 LOT', () => {
  it('원천 라인으로 숫자34 번호를 만들고 공급사 원문 식별자와 IQC 의뢰 문맥을 함께 넘긴다', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 7);

    expect(recorded.register).toMatchObject({
      lotNo: '9900200010000001002609111000190010',
      itemId: 9270,
      initialQty: 100,
      uomId: 8401,
      plantId: 1,
      externalIdentifiers: [
        {
          identifierTypeCode: 'SUPPLIER_LOT',
          externalIdentifier: '납품서-LOT/A-01',
          partnerId: 19,
        },
      ],
      incomingIqc: {
        requestNo: 'IRQ-20260911-0001',
        effectiveDate: '2026-09-11',
        requestedAt: '2026-09-11T08:00:00+07:00',
      },
    });
    expect(recorded.numbering).toEqual([['INSPECTION_REQUEST', 1n, '2026-09-11']]);
  });

  it('클라이언트 수량이 원천 라인과 다르면 LOT 트랜잭션 전에 400으로 막는다', async () => {
    const { service, recorded } = fake();

    await expect(service.create(input({ initialQty: 99 }), 7)).rejects.toMatchObject({
      errors: [{ field: 'initialQty', code: 'INVALID' }],
    });
    expect(recorded.register).toBeUndefined();
  });
});
