import type { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../../prisma/prisma.service';
import { TerminalService } from './terminal.service';

/** omf-all-around#333 — 단말 목록을 사용 여부(`isActive`)로 거른다(단말기-공정 매핑의 사용 · 미사용 라벨). */
function harness() {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    terminal: { findMany, count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  return { service: new TerminalService(prisma, {} as JwtService), findMany };
}

const whereOf = (findMany: jest.Mock): Record<string, unknown> =>
  (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

describe('단말 목록 — 사용 여부 조건 (omf-all-around#333)', () => {
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

describe('단말 목록 — 설치 설비 · 등록 여부 조건 (omf-all-around#333)', () => {
  const TOKEN_VERSION = { name: 'token_version' };
  const withFields = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      terminal: { findMany, count: jest.fn().mockResolvedValue(0), fields: { token_version: TOKEN_VERSION } },
    } as unknown as PrismaService;
    return { service: new TerminalService(prisma, {} as JwtService), findMany };
  };

  it('equipmentId 를 주면 그 설비의 단말만', async () => {
    const { service, findMany } = withFields();
    await service.list({ equipmentId: 7 });
    expect(whereOf(findMany)).toMatchObject({ equipment_id: 7 });
  });

  it('warehouseId 를 주면 그 창고의 단말만', async () => {
    const { service, findMany } = withFields();
    await service.list({ warehouseId: 11 });
    expect(whereOf(findMany)).toMatchObject({ warehouse_id: 11 });
  });

  it('REGISTERED 면 확인 시각이 있고 지금 세대 토큰으로 확인된 것만', async () => {
    const { service, findMany } = withFields();
    await service.list({ registrationStatusCode: 'REGISTERED' });
    expect(whereOf(findMany).AND).toEqual([
      { registration_confirmed_at: { not: null } },
      { registered_token_version: { equals: TOKEN_VERSION } },
    ]);
  });

  it('UNREGISTERED 면 확인 전 · 세대 어긋남을 모두 포함', async () => {
    const { service, findMany } = withFields();
    await service.list({ registrationStatusCode: 'UNREGISTERED' });
    expect(whereOf(findMany).AND).toEqual([
      {
        OR: [
          { registration_confirmed_at: null },
          { registered_token_version: null },
          { registered_token_version: { not: { equals: TOKEN_VERSION } } },
        ],
      },
    ]);
  });

  it('주지 않으면 등록 조건을 걸지 않는다', async () => {
    const { service, findMany } = withFields();
    await service.list({});
    expect(whereOf(findMany)).not.toHaveProperty('AND');
  });
});

describe('단말 다시 사용 (omf-all-around#333)', () => {
  it('판을 맞춰 is_active=true 로 켜고, 판이 어긋나면 갱신하지 않는다', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { terminal: { updateMany } } as unknown as PrismaService;
    const service = new TerminalService(prisma, {} as JwtService);
    const get = jest.spyOn(service, 'get').mockResolvedValue({ terminal: {} as never, versionNo: 4 });
    jest.spyOn(service as unknown as { assertExists: () => Promise<void> }, 'assertExists').mockResolvedValue();

    await service.activate(5, 3);

    expect(updateMany).toHaveBeenCalledWith({
      where: { terminal_id: 5, version_no: 3 },
      data: { is_active: true, version_no: { increment: 1 } },
    });
    expect(get).toHaveBeenCalledWith(5);
  });
});
