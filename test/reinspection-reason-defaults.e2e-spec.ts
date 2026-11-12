import { PrismaClient } from '@prisma/client';

/**
 * 피처 005 FR-023a — 불합격·보류를 덮는 IQC 결과는 재검 사유가 필수라 기본값이 있어야 한다. 배포는 시드를 안 돌리므로
 * 마이그 `20261113090000_reinspection_reason_defaults` 가 넣는다 — 베트남어 이름(name_vi)은 마이그에만 있어 마이그가 돌았다는 증거다.
 */
describe('재검 사유 기본값(REINSPECTION_REASON) (e2e)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('FR-023a 마이그가 넣은 기본값 둘 — 재측정·재작업 후 재검(베트남어 이름 포함), 그룹은 열린 그룹', async () => {
    const group = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: 'REINSPECTION_REASON' },
      select: { is_system_owned: true, code_value: { where: { code: { in: ['REMEASURE', 'REWORK_REINSPECT'] } }, orderBy: { display_order: 'asc' } } },
    });
    expect(group.is_system_owned).toBe(false);
    expect(group.code_value.map((value) => [value.code, value.code_name, value.display_order, value.name_vi, value.is_active])).toEqual([
      ['REMEASURE', '재측정', 10, 'Đo lại', true],
      ['REWORK_REINSPECT', '재작업 후 재검', 20, 'Kiểm lại sau gia công lại', true],
    ]);
  });
});
