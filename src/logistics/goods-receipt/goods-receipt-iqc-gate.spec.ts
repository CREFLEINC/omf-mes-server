import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { OutboxService } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptCreate } from './receipt-posting';

// 코드값 검사는 이 검사의 관심이 아니다 — 시드 없이 통과시킨다.
jest.mock('../../common/master', () => ({
  ...jest.requireActual('../../common/master'),
  assertCodeValues: async () => undefined,
}));

interface Quantities {
  /** LOT 의 `initial_qty`. 기본 100 — 입고 5 가 넉넉히 들어간다. */
  initialQty?: number;
  /** 선별로 떼어 낸 자식 LOT 수량 합. */
  splitQty?: number;
  /** 이미 전기된 입고 수량 합. */
  receivedQty?: number;
  /** 선별 원장 이동으로 그 LOT 에 이미 들어온 수량(입고 뒤 선별한 자식 LOT). */
  sortedInQty?: number;
  /** 선별 자식이면 그 부모 — `findUnique` 가 lot_id 로 갈라 답한다. */
  parent?: Record<string, unknown>;
}

/** 입고 전 검증(`assertWritable`)까지만 답하는 스텁 — 통과하면 채번에서 멈춘다. */
function stub(lot: Record<string, unknown>, inspectionRequired: boolean | null, isDefect = false, qty: Quantities = {}) {
  const prisma = {
    warehouse: { findUnique: async () => ({ plant_id: 1n, is_defect: isDefect }) },
    plant: { findUnique: async () => ({ plant_id: 1n }) },
    uom: { findUnique: async () => ({ uom_id: 1n }) },
    location: { findFirst: async () => ({ location_id: 1n }) },
    lot: {
      findUnique: async ({ where }: { where: { lot_id: bigint } }) =>
        qty.parent !== undefined && where.lot_id === 30n ? qty.parent : lot,
      findMany: async () => [{ lot_id: 20n, initial_qty: new Prisma.Decimal(qty.initialQty ?? 100) }],
      groupBy: async () =>
        qty.splitQty === undefined ? [] : [{ parent_lot_id: 20n, _sum: { initial_qty: new Prisma.Decimal(qty.splitQty) } }],
    },
    goods_receipt_line: {
      groupBy: async () =>
        qty.receivedQty === undefined ? [] : [{ lot_id: 20n, _sum: { receipt_qty: new Prisma.Decimal(qty.receivedQty) } }],
    },
    inventory_transaction_line: {
      groupBy: async () =>
        qty.sortedInQty === undefined ? [] : [{ lot_id: 20n, _sum: { qty: new Prisma.Decimal(qty.sortedInQty) } }],
    },
    inbound_receipt_line: {
      findUnique: async () => (inspectionRequired === null ? null : { inspection_required: inspectionRequired }),
    },
  };
  const numbering = {
    next: async () => {
      throw new Error('PASSED_VALIDATION');
    },
  };
  return new GoodsReceiptService(
    prisma as unknown as PrismaService,
    {} as InventoryPostingService,
    numbering as unknown as NumberingService,
    {} as OutboxService,
  );
}

const input: GoodsReceiptCreate = {
  receiptTypeCode: 'MATERIAL',
  plantId: 1,
  warehouseId: 1,
  receiptDatetime: '2026-10-16T01:00:00.000Z',
  businessDate: '2026-10-16',
  lines: [
    {
      inboundReceiptLineId: 7,
      itemId: 10,
      lotId: 20,
      receiptQty: 5,
      uomId: 1,
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
      destinationLocationId: 1,
    },
  ],
};

const inboundLot = (status: string) => ({
  item_id: 10n,
  status_code: status,
  source_type_code: 'INBOUND_RECEIPT_LINE',
  source_id: 7n,
});

async function errorOf(service: GoodsReceiptService): Promise<unknown> {
  return service.create(input, 1).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('GoodsReceiptService — IQC 합격 전 입고 차단 (omf-all-around#100)', () => {
  it('IQC 대상 입하 LOT 이 검사 대기면 lines[0].lotId STATE_LOCKED 로 막는다', async () => {
    const error = await errorOf(stub(inboundLot('INSPECTION_PENDING'), true));

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('lines[0].lotId');
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('STATE_LOCKED');
  });

  /* omf-all-around#84 · P-45 — IQC 불합격 LOT 은 불량창고로만 입고된다. */
  it('IQC 불합격(DEFECTIVE) LOT 을 불량창고로 입고하면 통과한다', async () => {
    const error = await errorOf(stub(inboundLot('DEFECTIVE'), true, true));
    expect((error as Error).message).toBe('PASSED_VALIDATION');
  });

  it('IQC 불합격 LOT 을 일반 창고로 입고하면 불량창고 안내로 막는다', async () => {
    const error = await errorOf(stub(inboundLot('DEFECTIVE'), true, false));
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('불량창고로만');
  });

  it('검사 대기 LOT 은 불량창고로도 입고되지 않는다', async () => {
    const error = await errorOf(stub(inboundLot('INSPECTION_PENDING'), true, true));
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('합격 전인');
  });

  /* 불합격(C6 → DEFECTIVE)·보류 판정 LOT 은 일반 창고로 입고되지 않는다 — 처분(C19 정상·특채)으로 NORMAL 이 된 뒤에만 들어간다. */
  it.each(['DEFECTIVE', 'SCRAPPED'])('IQC 대상 %s LOT 은 일반 창고로 막는다', async (status) => {
    const error = await errorOf(stub(inboundLot(status), true));

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('STATE_LOCKED');
  });

  it('IQC 대상이어도 합격(NORMAL) LOT 은 통과한다 — 처분 정상(C19)으로 돌아온 LOT 도 같다', async () => {
    const error = await errorOf(stub(inboundLot('NORMAL'), true));
    expect((error as Error).message).toBe('PASSED_VALIDATION');
  });

  it('IQC 비대상 입하 LOT 은 검사 대기여도 기존대로 통과한다', async () => {
    const error = await errorOf(stub(inboundLot('INSPECTION_PENDING'), false));
    expect((error as Error).message).toBe('PASSED_VALIDATION');
  });

  it('입하가 아닌 LOT(생산 등)은 검사하지 않는다', async () => {
    const error = await errorOf(
      stub({ item_id: 10n, status_code: 'INSPECTION_PENDING', source_type_code: 'WORK_ORDER', source_id: 1n }, null),
    );
    expect((error as Error).message).toBe('PASSED_VALIDATION');
  });

});

/* 장부 P-56 · 3단계 검증 — 입고 전 선별(SORT)로 양품 35 / 불량 15 를 가른 LOT 은 35 까지만 입고한다. */
describe('GoodsReceiptService — 입하 LOT 입고 상한 (P-56)', () => {
  const at = (qtyInput: number) => ({ ...input, lines: [{ ...input.lines[0], receiptQty: qtyInput }] });
  const errorFor = (service: GoodsReceiptService, receiptQty: number) =>
    service.create(at(receiptQty), 1).then(() => undefined, (error: unknown) => error);

  it('⛔ 선별로 떼어 낸 불량분을 넘겨 입고하면 lines[0].receiptQty 로 막는다', async () => {
    const service = stub(inboundLot('NORMAL'), true, false, { initialQty: 50, splitQty: 15 });

    const error = await errorFor(service, 50);

    expect(error).toBeInstanceOf(ContractException);
    const body = JSON.stringify((error as ContractException).getResponse());
    expect(body).toContain('lines[0].receiptQty');
    expect(body).toContain('35');
  });

  it('양품 수량(35)까지는 통과한다', async () => {
    const service = stub(inboundLot('NORMAL'), true, false, { initialQty: 50, splitQty: 15 });
    expect(((await errorFor(service, 35)) as Error).message).toBe('PASSED_VALIDATION');
  });

  it('이미 입고한 수량도 뺀다', async () => {
    const service = stub(inboundLot('NORMAL'), true, false, { initialQty: 50, receivedQty: 40 });
    expect(JSON.stringify(((await errorFor(service, 20)) as ContractException).getResponse())).toContain('receiptQty');
  });

  /* #108 리뷰 m2 — 같은 LOT 을 여러 줄로 나눠 보내도 상한은 LOT 합계로 본다. */
  it('⛔ 같은 LOT 의 줄 합계가 입고 가능 수량을 넘으면 막는다', async () => {
    const service = stub(inboundLot('NORMAL'), true, false, { initialQty: 50, splitQty: 15 });
    const twoLines = { ...input, lines: [{ ...input.lines[0], receiptQty: 20 }, { ...input.lines[0], receiptQty: 20 }] };

    const error = await service.create(twoLines, 1).then(() => undefined, (caught: unknown) => caught);

    expect(JSON.stringify((error as ContractException).getResponse())).toContain('receiptQty');
  });

  it('입하가 아닌 LOT(생산 등)은 상한을 보지 않는다 — 제품 LOT 선별은 그대로다', async () => {
    const service = stub(
      { item_id: 10n, status_code: 'NORMAL', source_type_code: 'WORK_ORDER', source_id: 1n },
      null,
      false,
      { initialQty: 1 },
    );
    expect(((await errorFor(service, 5)) as Error).message).toBe('PASSED_VALIDATION');
  });

  describe('선별 불량분(자식 LOT)', () => {
    const child = {
      item_id: 10n, status_code: 'DEFECTIVE', source_type_code: 'LOT_SPLIT', source_id: 30n, parent_lot_id: 30n,
    };
    const parent = { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 7n, parent_lot_id: null };

    it('⛔ 조상의 입하 라인을 따라 IQC 규칙이 걸린다 — 일반 창고는 막는다', async () => {
      const service = stub(child, true, false, { initialQty: 15, parent });
      expect(JSON.stringify(((await errorFor(service, 15)) as ContractException).getResponse())).toContain('불량창고로만');
    });

    /* #108 리뷰 C1 — 불량창고에 입고한 뒤 선별하면 불량분 재고는 원장 이동으로 이미 생겼다. 다시 입고하지 않는다. */
    it('⛔ 선별 원장 이동으로 재고가 이미 들어온 자식 LOT 은 입고 가능 0 이다', async () => {
      const service = stub(child, true, true, { initialQty: 3, parent, sortedInQty: 3 });
      const body = JSON.stringify(((await errorFor(service, 3)) as ContractException).getResponse());
      expect(body).toContain('receiptQty');
      expect(body).toContain('0 까지');
    });

    it('불량창고로는 그 수량만큼 입고된다', async () => {
      const service = stub(child, true, true, { initialQty: 15, parent });
      expect(((await errorFor(service, 15)) as Error).message).toBe('PASSED_VALIDATION');
      expect(JSON.stringify(((await errorFor(service, 16)) as ContractException).getResponse())).toContain('receiptQty');
    });
  });
});
