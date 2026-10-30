import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { inspectionRequestListWhere } from './inspection-request.service';

/** omf-all-around#205 — 의뢰 시각 반열림 구간. 공장 하루의 경계는 화면이 오프셋으로 보낸다. */
const prisma = {} as PrismaService;
const requestedAtOf = async (query: Record<string, string>) => {
  const where = await inspectionRequestListWhere(prisma, query);
  return (where.AND as Record<string, unknown>[]).find((part) => 'requested_at' in part);
};

describe('의뢰 목록 의뢰 시각 구간', () => {
  it('from 이상 · to 미만으로 거른다', async () => {
    await expect(
      requestedAtOf({ requestedAtFrom: '2026-10-30T00:00:00+07:00', requestedAtTo: '2026-10-31T00:00:00+07:00' }),
    ).resolves.toEqual({
      requested_at: { gte: new Date('2026-10-29T17:00:00Z'), lt: new Date('2026-10-30T17:00:00Z') },
    });
  });

  it('조건이 없으면 거르지 않는다', async () => {
    await expect(requestedAtOf({})).resolves.toBeUndefined();
  });

  it.each(['2026-10-30', '2026-10-30T00:00:00', '어제'])('오프셋 없는 %s 는 400 INVALID', async (value) => {
    const error = await inspectionRequestListWhere(prisma, { requestedAtFrom: value }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors[0]).toMatchObject({ field: 'requestedAtFrom', code: 'INVALID' });
  });
});
