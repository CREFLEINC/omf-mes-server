import { ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptCreate } from './receipt-posting';

// 코드값 검사는 이 검사의 관심이 아니다 — 시드 없이 통과시킨다.
jest.mock('../../common/master', () => ({
  ...jest.requireActual('../../common/master'),
  assertCodeValues: async () => undefined,
}));

/** 입고 전 검증(`assertWritable`)까지만 답하는 스텁 — 통과하면 채번에서 멈춘다. */
function stub(lot: Record<string, unknown>, inspectionRequired: boolean | null) {
  const prisma = {
    warehouse: { findUnique: async () => ({ plant_id: 1n }) },
    plant: { findUnique: async () => ({ plant_id: 1n }) },
    uom: { findUnique: async () => ({ uom_id: 1n }) },
    location: { findFirst: async () => ({ location_id: 1n }) },
    lot: { findUnique: async () => lot },
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

  /* 불합격(C6 → DEFECTIVE)·보류 판정 LOT 도 입고되지 않는다 — 처분(C19 정상·특채)으로 NORMAL 이 된 뒤에만 들어간다. */
  it.each(['DEFECTIVE', 'SCRAPPED'])('IQC 대상 %s LOT 은 막는다', async (status) => {
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
