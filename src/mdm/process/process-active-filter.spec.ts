import { PrismaService } from '../../prisma/prisma.service';
import { ProcessService } from './process.service';

/** omf-all-around#231 — 공정 목록을 사용 여부(`isActive`)로 거른다(공정 관리 탭의 사용 · 미사용 라벨). */
function harness() {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    process: { findMany, count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  return { service: new ProcessService(prisma), findMany };
}

const whereOf = (findMany: jest.Mock): Record<string, unknown> =>
  (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

describe('공정 목록 — 사용 여부 조건 (omf-all-around#231)', () => {
  it('isActive=false 면 미사용만 — includeInactive 가 없어도 기본(사용만)을 덮는다', async () => {
    const { service, findMany } = harness();

    await service.list({ isActive: false });

    expect(whereOf(findMany)).toMatchObject({ is_active: false });
  });

  it('isActive=true 면 사용만 — includeInactive 를 함께 줘도 사용만', async () => {
    const { service, findMany } = harness();

    await service.list({ isActive: true, includeInactive: true });

    expect(whereOf(findMany)).toMatchObject({ is_active: true });
  });

  it('isActive 가 없으면 종전 그대로 — 기본은 사용만, includeInactive 면 조건 없음', async () => {
    const first = harness();
    await first.service.list({});
    expect(whereOf(first.findMany)).toMatchObject({ is_active: true });

    const second = harness();
    await second.service.list({ includeInactive: true });
    expect(whereOf(second.findMany)).not.toHaveProperty('is_active');
  });

  it('processTypeCode 를 주면 그 유형만 — 빈 값이면 조건을 걸지 않는다', async () => {
    const typed = harness();
    await typed.service.list({ processTypeCode: 'ASSEMBLY' });
    expect(whereOf(typed.findMany)).toMatchObject({ process_type_code: 'ASSEMBLY' });

    const blank = harness();
    await blank.service.list({ processTypeCode: '' });
    expect(whereOf(blank.findMany)).not.toHaveProperty('process_type_code');
  });
});
