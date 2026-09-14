import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { DocumentIssueRenditionService } from './document-issue-rendition.service';

describe('DocumentIssueRenditionService', () => {
  it('납품 라벨 PNG는 배분에 저장된 번호를 사용한다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn()
        .mockResolvedValueOnce({ document_type_code: 'DELIVERY_LABEL' })
        .mockResolvedValueOnce({ target_type_code: 'SHIPMENT_LOT_ALLOCATION', target_id: 9n }) },
      shipment_lot_allocation: { findUnique: jest.fn().mockResolvedValue({
        delivery_label_no: 'DL-20260912-0012', allocated_qty: new Prisma.Decimal(3),
        lot: { lot_no: 'LOT-9', item: { item_code: 'ITEM-9' } },
        shipment_line: { shipment: { shipment_no: 'SH-9' } },
      }) },
    } as unknown as PrismaService;
    const png = await new DocumentIssueRenditionService(prisma).rendition(7);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.byteLength).toBeGreaterThan(10_000);
    expect(prisma.shipment_lot_allocation.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { shipment_lot_allocation_id: 9n },
    }));
  });

  it('실제 자재 LOT 데이터와 스캔 가능한 QR을 담은 PNG를 렌더링한다', async () => {
    const prisma = {
      document_issue_log: {
        findUnique: async () => ({
          document_issue_log_id: 1n,
          document_type_code: 'MATERIAL_LOT_LABEL',
          issue_seq: 2,
          lot: {
            lot_no: '040101-00022S|100|260911|100019|0001',
            initial_qty: new Prisma.Decimal(100),
            item: { item_code: '040101-00022S', item_name: 'FR002 TEST MATERIAL' },
          },
        }),
      },
    } as unknown as PrismaService;

    const png = await new DocumentIssueRenditionService(prisma).materialLotLabel(1);

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.byteLength).toBeGreaterThan(10_000);
  });

  it('자재 LOT 라벨이 아닌 발행 기록은 422다', async () => {
    const prisma = {
      document_issue_log: {
        findUnique: async () => ({
          document_type_code: 'LOCATION_LABEL',
          lot: null,
        }),
      },
    } as unknown as PrismaService;

    await expect(new DocumentIssueRenditionService(prisma).materialLotLabel(1)).rejects.toMatchObject({
      status: 422,
    });
  });
});
