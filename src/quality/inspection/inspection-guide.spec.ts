import { PrismaService } from '../../prisma/prisma.service';
import { inspectionGuides } from './inspection-guide';

/** omf-all-around#252 — 의뢰 상세의 검사 안내(공통 + 품목). */
describe('검사 안내 문구', () => {
  const request = { inspection_plan_version_id: 21n, requested_at: new Date('2026-11-10T03:00:00Z') };
  const setup = (version: Record<string, unknown> | null, commons: Record<string, unknown>[] = []) => {
    const findMany = jest.fn(async () => commons);
    const prisma = {
      inspection_plan_version: { findUnique: jest.fn(async () => version), findMany },
    } as unknown as PrismaService;
    return { prisma, findMany };
  };
  const common = (id: bigint, ko: string | null, ver = 1) => ({
    inspection_plan_id: id, plan_version: ver, guide_text: ko,
  });

  it('공통 기준을 쓰는 의뢰는 그 문구 하나(COMMON)다 — 다시 찾지 않는다', async () => {
    const { prisma, findMany } = setup({
      guide_text: 'NG 확인', inspection_plan: { item_id: null, inspection_type_code: 'IQC' },
    });

    expect(await inspectionGuides(prisma, request)).toEqual([{ scopeCode: 'COMMON', guideText: 'NG 확인' }]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('품목 기준을 쓰는 의뢰는 그날 유효한 공통 기준 문구를 앞에, 품목 문구를 뒤에 싣는다', async () => {
    const { prisma, findMany } = setup(
      { guide_text: '도면 3번', inspection_plan: { item_id: 3n, inspection_type_code: 'IQC' } },
      [common(1n, '옛 공통', 1), common(1n, 'NG 확인', 2)],
    );

    expect(await inspectionGuides(prisma, request)).toEqual([
      { scopeCode: 'COMMON', guideText: 'NG 확인' },
      { scopeCode: 'ITEM', guideText: '도면 3번' },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status_code: 'CONFIRMED',
        inspection_plan: { item_id: null, inspection_type_code: 'IQC', is_active: true },
      }),
    }));
  });

  it('공통 기준이 둘 이상이면 공통 문구를 싣지 않는다 · 문구가 없으면 빈 목록이다', async () => {
    const two = setup(
      { guide_text: '도면 3번', inspection_plan: { item_id: 3n, inspection_type_code: 'IQC' } },
      [common(1n, 'A'), common(2n, 'B')],
    );
    expect((await inspectionGuides(two.prisma, request)).map((g) => g.scopeCode)).toEqual(['ITEM']);

    const blank = setup(
      { guide_text: '  ', inspection_plan: { item_id: 3n, inspection_type_code: 'IQC' } },
      [common(1n, null)],
    );
    expect(await inspectionGuides(blank.prisma, request)).toEqual([]);
    expect(await inspectionGuides(setup(null).prisma, { ...request, inspection_plan_version_id: null })).toEqual([]);
  });
});
