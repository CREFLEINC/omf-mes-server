import { PrismaService } from '../../prisma/prisma.service';
import { InspectionSheetQueryService } from './inspection-sheet-query.service';

/** 제품 검사표 목록 — 양식(OP향 · PP향)으로 거른다(omf-all-around#217). */
function harness() {
  const prisma = {
    inspection_sheet: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  return { prisma, service: new InspectionSheetQueryService(prisma as unknown as PrismaService) };
}

describe('InspectionSheetQueryService.list — 양식 조건', () => {
  it('formLayoutCode 를 주면 검사표 기준의 양식으로 거른다', async () => {
    const { prisma, service } = harness();

    await service.list({ formLayoutCode: 'PP' }, [2n]);

    const where = prisma.inspection_sheet.findMany.mock.calls[0][0].where;
    expect(where.template).toEqual({ form_layout_code: 'PP' });
    expect(prisma.inspection_sheet.count.mock.calls[0][0].where).toEqual(where);
  });

  it('formLayoutCode 가 없으면 양식으로 거르지 않는다', async () => {
    const { prisma, service } = harness();

    await service.list({}, [2n]);

    expect(prisma.inspection_sheet.findMany.mock.calls[0][0].where.template).toBeUndefined();
  });
});

describe('InspectionSheetQueryService.list — 작성자 이름(omf-all-around#316)', () => {
  const row = (written: string | null, creator: string | null) => ({
    inspection_sheet_id: 1n,
    serial_number: { serial_no: 'SN-1', oqc_serial_result: null },
    item: { item_code: 'I', item_name: '품목' },
    lot: { lot_no: 'L' },
    work_order: null,
    status_code: 'IN_PROGRESS',
    template: { steps: [] },
    step_results: [],
    written_worker: written === null ? null : { worker_name: written },
    app_user_inspection_sheet_created_byToapp_user: creator === null ? null : { user_name: creator },
    app_user_inspection_sheet_approved_byToapp_user: null,
    app_user_inspection_sheet_checked_byToapp_user: null,
    created_at: new Date('2026-11-19T00:00:00Z'),
  });

  it.each([
    ['POP 작업자가 쓰면 작업자 이름', '작업자', null, '작업자'],
    ['관리웹 계정이 만들면 계정 이름', null, '품질 담당', '품질 담당'],
    ['둘 다 없으면 null', null, null, null],
  ])('%s', async (_, written, creator, expected) => {
    const { prisma, service } = harness();
    prisma.inspection_sheet.findMany.mockResolvedValue([row(written, creator)]);
    prisma.inspection_sheet.count.mockResolvedValue(1);

    const page = await service.list({}, [2n]);

    expect(page.items[0].writtenWorkerName).toBe(expected);
  });
});
