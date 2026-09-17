import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { DocumentIssueRenditionService } from './document-issue-rendition.service';

describe('DocumentIssueRenditionService', () => {
  // ⭐ 종전에는 서버가 배분의 `delivery_label_no` 로 납품 라벨 PNG 를 그렸다. 주인이 출하
  //    단위로 옮겨가며(SHIP-UNIT-01) 그 그리기를 걷었다 — POP 이 상세 값으로 그린다.
  it('납품 라벨은 서버가 그리지 않는다 — 422다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn()
        .mockResolvedValue({ document_type_code: 'DELIVERY_LABEL' }) },
    } as unknown as PrismaService;
    await expect(new DocumentIssueRenditionService(prisma).rendition(7)).rejects.toMatchObject({
      status: 422,
    });
  });

  const materialLotIssue = {
    document_type_code: 'MATERIAL_LOT_LABEL',
    issue_seq: 2,
    issued_at: new Date('2026-09-11T02:00:00Z'),
    lot: {
      lot_no: '040101-00022S|1250|260911|100019|0001',
      lot_type_code: 'MATERIAL',
      status_code: 'INSPECTION_PENDING',
      initial_qty: new Prisma.Decimal('1250.000000'),
      manufactured_at: null,
      item: { item_code: '040101-00022S' },
      uom: { uom_code: 'EA' },
      plant: { timezone_code: 'Asia/Ho_Chi_Minh' },
    },
  };

  it('자재 LOT PNG 렌디션은 발행 기록의 LOT 값으로 80×30mm 라벨을 그린다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn().mockResolvedValue(materialLotIssue) },
    } as unknown as PrismaService;

    const png = await new DocumentIssueRenditionService(prisma).rendition(7);

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    // IHDR 너비·높이 — 203dpi 80×30mm.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([639, 240]);
  });

  it('자재 LOT TSPL 렌디션은 발행 기록의 LOT·품목·수량·단위·회차·공장 시각을 쓴다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn().mockResolvedValue(materialLotIssue) },
    } as unknown as PrismaService;
    const text = (await new DocumentIssueRenditionService(prisma).rendition(7, 'tspl')).toString('ascii');
    expect(text.startsWith('SIZE ')).toBe(true);
    expect(text).toContain('"RAW  INSPECTION_PENDING"');
    expect(text).toContain('"PART NO.: 040101-00022S"');
    expect(text).toContain('"QTY: 1,250 EA"');
    expect(text).toContain('"LOT NO.: 040101-00022S|1250|260911|100019|0001"');
    expect(text).toContain('"MFG DT: 26-09-11 09:00"');
    expect(text).toContain('"ISSUE NO.: 2"');
    expect(text).toContain(',"040101-00022S|1250|260911|100019|0001"\r\nPRINT 1\r\n');
    expect(prisma.document_issue_log.findUnique).toHaveBeenCalledTimes(2);
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

  const locationIssue = { document_type_code: 'LOCATION_LABEL' };
  const locationTarget = { issue_seq: 4, target_type_code: 'LOCATION', target_id: 42n };
  const locationRow = {
    location_code: 'A-01-03',
    location_name: 'RACK A1',
    warehouse: { warehouse_code: 'WH01' },
  };

  it('LOCATION_LABEL은 png를 낸다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn()
        .mockResolvedValueOnce(locationIssue)
        .mockResolvedValueOnce(locationTarget) },
      location: { findUnique: jest.fn().mockResolvedValue(locationRow) },
    } as unknown as PrismaService;

    const png = await new DocumentIssueRenditionService(prisma).rendition(11);

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('LOCATION_LABEL은 tspl을 낸다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn()
        .mockResolvedValueOnce(locationIssue)
        .mockResolvedValueOnce(locationTarget) },
      location: { findUnique: jest.fn().mockResolvedValue(locationRow) },
    } as unknown as PrismaService;

    const text = (await new DocumentIssueRenditionService(prisma).rendition(11, 'tspl')).toString('ascii');

    expect(text.startsWith('SIZE ')).toBe(true);
    expect(text).toContain('QRCODE 599,40,M,8,A,0,M2,S7,"A-01-03"');
  });

  it('대상 유형이 LOCATION이 아니면 422다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn()
        .mockResolvedValueOnce(locationIssue)
        .mockResolvedValueOnce({ ...locationTarget, target_type_code: 'LOT' }) },
      location: { findUnique: jest.fn().mockResolvedValue(locationRow) },
    } as unknown as PrismaService;

    await expect(new DocumentIssueRenditionService(prisma).rendition(11)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('가리키는 위치가 지워졌으면 422다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn()
        .mockResolvedValueOnce(locationIssue)
        .mockResolvedValueOnce(locationTarget) },
      location: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    await expect(new DocumentIssueRenditionService(prisma).rendition(11)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('없는 발행 기록은 404다', async () => {
    const prisma = {
      document_issue_log: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    await expect(new DocumentIssueRenditionService(prisma).rendition(11)).rejects.toMatchObject({
      status: 404,
    });
  });
});
