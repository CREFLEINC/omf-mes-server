import { PrismaService } from '../../prisma/prisma.service';
import { inspectionRequestListWhere } from './inspection-request.service';

/** omf-all-around#356 — 검사 조회·판정의 종합 판정 필터. 확정 때 서버가 적은 의뢰의 판정으로 거른다. */
const prisma = {} as PrismaService;

describe('의뢰 목록 종합 판정 필터', () => {
  it('준 판정과 같은 의뢰만 고른다', async () => {
    await expect(inspectionRequestListWhere(prisma, { overallJudgmentCode: 'REJECTED' })).resolves.toMatchObject({
      overall_judgment_code: 'REJECTED',
    });
  });

  it('조건이 없으면 판정으로 거르지 않는다', async () => {
    const where = await inspectionRequestListWhere(prisma, {});
    expect(where).not.toHaveProperty('overall_judgment_code');
  });
});
