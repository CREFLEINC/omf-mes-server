import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { DocumentIssueRenditionService } from './document-issue-rendition.service';

describe('DocumentIssueRenditionService', () => {
  it('실제 자재 LOT 데이터와 스캔 가능한 QR을 담은 PNG를 렌더링한다', async () => {
    const prisma = {
      document_issue_log: {
        findUnique: async () => ({
          document_issue_log_id: 1n,
          document_type_code: 'MATERIAL_LOT_LABEL',
          issue_seq: 2,
          lot: {
            lot_no: '9900200010000001002609111000190001',
            initial_qty: new Prisma.Decimal(100),
            item: { item_code: '990020001', item_name: 'FR002 TEST MATERIAL' },
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
