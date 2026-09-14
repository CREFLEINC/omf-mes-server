import { Prisma } from '@prisma/client';

import { LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { LotCreate, LotService } from './lot.service';

type Args = Record<string, unknown>;

const ITEM_CODE = '040101-00022S';
const SUPPLIER_CODE = '100019';

const source = (receivedQty: number) => ({
  inbound_receipt_line_id: 77n,
  inbound_receipt_id: 88n,
  line_no: 1,
  purchase_order_line_id: 99n,
  asn_line_id: null,
  item_id: 9270n,
  received_qty: new Prisma.Decimal(receivedQty),
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
});

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

/**
 * @param receivedQty 입하 라인 수량 — `source().received_qty` 와 `nextInboundMaterialLotNo` 접두
 *   양쪽에 같은 값을 먹인다(`fromInboundSource` 가 `Decimal.equals` 로 대조하기 때문).
 * @param existingLotNoSuffix 기존 LOT 하나를 심어 다음 번호가 그 뒤를 잇는지 본다.
 */
function fake(receivedQty = 100, existingLotNoSuffix = '0009') {
  const recorded = {
    register: undefined as Args | undefined,
    numbering: [] as unknown[][],
  };
  const receiptLine = source(receivedQty);
  const tx = {
    inbound_receipt_line: { findUnique: async () => receiptLine },
    item: { findUnique: async () => ({ item_code: ITEM_CODE }) },
    partner: { findUnique: async () => ({ partner_code: SUPPLIER_CODE }) },
    lot: {
      findMany: async () => [
        { lot_no: `${ITEM_CODE}|${String(receivedQty)}|260911|${SUPPLIER_CODE}|${existingLotNoSuffix}` },
      ],
    },
  };
  const prisma = {
    inbound_receipt_line: { findUnique: async () => receiptLine },
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
  it('원천 라인으로 구분자 5칸 번호를 만들고 공급사 원문 식별자와 IQC 의뢰 문맥을 함께 넘긴다', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 7);

    expect(recorded.register).toMatchObject({
      lotNo: `${ITEM_CODE}|100|260911|${SUPPLIER_CODE}|0010`,
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

  // ⭐ 옛 34자리 형식은 수량 칸이 정수 9자리 고정이라 소수 수량이 400으로 막혔다(materialMesLotNo
  // 의 integer() 가정). 구분자 형식은 정규형 소수 문자열을 쓰므로 이 경로가 열린다 — 회귀 확인.
  it('소수 수량(KG 등)도 LOT 번호에 정규형으로 그대로 실린다 — 옛 정수 전용 제약의 회귀 확인', async () => {
    const { service, recorded } = fake(12.5, '0002');

    await service.create(input({ initialQty: 12.5 }), 7);

    expect(recorded.register).toMatchObject({
      lotNo: `${ITEM_CODE}|12.5|260911|${SUPPLIER_CODE}|0003`,
    });
  });
});
