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
