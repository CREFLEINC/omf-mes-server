import { PrismaService } from '../../prisma/prisma.service';
import { inspectionGuides } from './inspection-guide';

/** omf-all-around#252 — 의뢰 상세의 검사 안내. */
describe('검사 안내 문구', () => {
  const request = { inspection_plan_version_id: 21n, requested_at: new Date('2026-11-10T03:00:00Z') };
  const setup = (version: Record<string, unknown> | null) => {
    const findMany = jest.fn(async () => []);
    const prisma = {
      inspection_plan_version: { findUnique: jest.fn(async () => version), findMany },
    } as unknown as PrismaService;
    return { prisma, findMany };
  };

  it('공통 기준을 쓰는 의뢰는 그 문구 하나(COMMON)다 — 다시 찾지 않는다', async () => {
    const { prisma, findMany } = setup({
      guide_text: 'NG 확인', inspection_plan: { item_id: null, inspection_type_code: 'IQC' },
    });

    expect(await inspectionGuides(prisma, request)).toEqual([{ scopeCode: 'COMMON', guideText: 'NG 확인' }]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('품목 기준을 쓰는 의뢰는 그 품목 문구 하나(ITEM)다 — 공통 기준 문구를 덧붙이지 않는다(omf-all-around#366)', async () => {
    const { prisma, findMany } = setup({ guide_text: '도면 3번', inspection_plan: { item_id: 3n, inspection_type_code: 'IQC' } });

    expect(await inspectionGuides(prisma, request)).toEqual([{ scopeCode: 'ITEM', guideText: '도면 3번' }]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('문구가 없으면 빈 목록이다', async () => {
    const blank = setup({ guide_text: '  ', inspection_plan: { item_id: 3n, inspection_type_code: 'IQC' } });
    expect(await inspectionGuides(blank.prisma, request)).toEqual([]);
    expect(await inspectionGuides(setup(null).prisma, { ...request, inspection_plan_version_id: null })).toEqual([]);
  });
});
