import { PrismaService } from '../../prisma/prisma.service';
import { inspectionRequestListWhere } from './inspection-request.service';

/**
 * omf-all-around#356 — 검사 조회·판정의 종합 판정 필터. 의뢰에 적힌 판정(입하 LOT IQC · 출하 OQC 새 흐름), 없으면 완료 의뢰의
 * 마지막 확정 결과 판정(PQC · 옛 OQC)으로 거른다.
 */
const judgmentPart = async (prisma: PrismaService, query: Record<string, string>) => {
  const where = await inspectionRequestListWhere(prisma, query);
  return (where.AND as Record<string, unknown>[]).find((part) => Array.isArray(part.OR) && 'overall_judgment_code' in (part.OR[0] as object));
};

describe('의뢰 목록 종합 판정 필터', () => {
  it('의뢰의 판정이거나, 판정이 빈 완료 의뢰는 마지막 확정 결과의 판정으로 고른다', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: 31n }, { id: 32n }]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;

    await expect(judgmentPart(prisma, { overallJudgmentCode: 'REJECTED' })).resolves.toEqual({
      OR: [
        { overall_judgment_code: 'REJECTED' },
        { overall_judgment_code: null, status_code: 'COMPLETED', inspection_request_id: { in: [31n, 32n] } },
      ],
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect((queryRaw.mock.calls[0] as unknown[]).slice(1)).toEqual(['REJECTED']);
  });

  it('조건이 없으면 판정으로 거르지 않고 결과를 읽지도 않는다', async () => {
    const queryRaw = jest.fn();
    await expect(judgmentPart({ $queryRaw: queryRaw } as unknown as PrismaService, {})).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
