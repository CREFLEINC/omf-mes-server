import { Prisma } from '@prisma/client';

import { assignDeliveryLabelNumbers, lockDeliveryAllocations } from './document-issue-delivery';
import { DocumentIssueTargetFacts } from './document-issue-create-rules';

describe('delivery label allocation ownership and numbering', () => {
  it('first issue persists the Seoul business-day number and reissue leaves it unchanged', async () => {
    const updates: object[] = [];
    const raw = jest.fn()
      .mockResolvedValueOnce([{ numbering_rule_id: 4n, pattern: 'DL-{YYYYMMDD}-{SEQ4}', is_active: true }])
      .mockResolvedValueOnce([{ last_value: 12n }]);
    const tx = {
      $queryRaw: raw,
      shipment_lot_allocation: { update: jest.fn().mockImplementation(async (args: object) => { updates.push(args); }) },
    } as unknown as Prisma.TransactionClient;
    const first: DocumentIssueTargetFacts = { targetTypeCode: 'SHIPMENT_LOT_ALLOCATION',
      targetId: 9n, lotId: 3n, plantId: 2n, oqcPassed: true, deliveryLabelNo: null };
    // 2026-09-11 15:01 UTC is 2026-09-12 in Korea.
    await assignDeliveryLabelNumbers(tx, [first], new Date('2026-09-11T15:01:00Z'));
    expect(updates).toEqual([{ where: { shipment_lot_allocation_id: 9n },
      data: { delivery_label_no: 'DL-20260912-0012' } }]);
    await assignDeliveryLabelNumbers(tx, [first], new Date('2026-09-13T12:00:00Z'));
    expect(raw).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(1);
  });

  it('foreign warehouse plant is denied even when OQC is not required', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ shipment_lot_allocation_id: 9n, lot_id: 3n,
        shipment_request_line_id: 7n, plant_id: 4n, delivery_label_no: null }]),
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
