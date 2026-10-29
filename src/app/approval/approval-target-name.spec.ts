import { approvalTargetNames, targetKey } from './approval-target-name';
import { toApprovalTarget } from './approval.mapper';

/** 승인 대상 이름 — 「INBOUND_LOT #19」 같은 내부 코드 대신 업무 번호를 낸다. */
describe('approvalTargetNames', () => {
  const prisma = {
    lot: { findMany: jest.fn().mockResolvedValue([{ lot_id: 19n, lot_no: 'IL-20261028-0001' }]) },
    nonconformance: { findMany: jest.fn().mockResolvedValue([{ nonconformance_id: 1n, nonconformance_no: 'NC-20261028-001' }]) },
    shipment_request: { findMany: jest.fn().mockResolvedValue([]) },
  };

  it('⭐ 품질 승인 대상은 「업무 이름 · 번호」, 못 찾거나 다른 유형은 「코드 #id」로 남는다', async () => {
    const names = await approvalTargetNames(prisma as never, [
      { target_type_code: 'INBOUND_LOT', target_id: 19n },
      { target_type_code: 'NONCONFORMANCE', target_id: 1n },
      { target_type_code: 'SHIPMENT_REQUEST', target_id: 7n },
      { target_type_code: 'PRODUCTION_RESULT', target_id: 5n },
    ]);
    const name = (type: string, id: bigint): string =>
      toApprovalTarget(type, id, names.get(targetKey(type, id))).displayName;

    expect(name('INBOUND_LOT', 19n)).toBe('입하 LOT · IL-20261028-0001');
    expect(name('NONCONFORMANCE', 1n)).toBe('부적합 · NC-20261028-001');
    expect(name('SHIPMENT_REQUEST', 7n)).toBe('SHIPMENT_REQUEST #7');
    expect(name('PRODUCTION_RESULT', 5n)).toBe('PRODUCTION_RESULT #5');
  });

  it('대상이 없는 유형은 조회하지 않는다', async () => {
    jest.clearAllMocks();
    await approvalTargetNames(prisma as never, [{ target_type_code: 'NONCONFORMANCE', target_id: 1n }]);
    expect(prisma.lot.findMany).not.toHaveBeenCalled();
    expect(prisma.shipment_request.findMany).not.toHaveBeenCalled();
  });
});
