import { PrismaService } from '../../prisma/prisma.service';
import { RoleService } from './role.service';

/** omf-all-around#333 — 역할 목록을 사용 여부(`isActive`)로 거른다(역할 · 권한 관리 탭의 사용 · 미사용 라벨). */
function harness() {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    role: { findMany, count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  return { service: new RoleService(prisma), findMany };
}

const whereOf = (findMany: jest.Mock): Record<string, unknown> =>
  (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

describe('역할 목록 — 사용 여부 조건 (omf-all-around#333)', () => {
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
});
