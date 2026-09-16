import { Prisma } from '@prisma/client';

import { lockDeliveryAllocations } from './document-issue-delivery';

// ⭐ 배분은 더 이상 납품 라벨의 대상이 아니다(SHIP-UNIT-01) — 이 잠금은 기존 이력을 되읽는
//    경로만 받친다. 배분에 번호를 매기던 `assignDeliveryLabelNumbers` 는 함께 걷었다(P-27).
describe('delivery label allocation ownership', () => {
  it('foreign warehouse plant is denied even when OQC is not required', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ shipment_lot_allocation_id: 9n, lot_id: 3n,
        shipment_request_line_id: 7n, plant_id: 4n }]),
      terminal: { findUnique: jest.fn().mockResolvedValue({ plant_id: 2n,
        terminal_type_code: 'POP', is_active: true }) },
      worker: { findUnique: jest.fn().mockResolvedValue({ plant_id: 2n, is_active: true }) },
      shipment_request_line: { findMany: jest.fn().mockResolvedValue([{ shipment_request_line_id: 7n,
        shipment_request_id: 6n, shipping_inspection_required: false }]) },
      inventory_reservation: { findMany: jest.fn().mockResolvedValue([]) },
      inspection_result: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as Prisma.TransactionClient;
    await expect(lockDeliveryAllocations(tx, [{ index: 0, targetTypeCode: 'SHIPMENT_LOT_ALLOCATION',
      targetId: 9n, requestedLotId: 3n }], 5n, 'W-9')).rejects.toMatchObject({ status: 403 });
  });
});
