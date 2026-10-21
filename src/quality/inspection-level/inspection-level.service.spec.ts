import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionLevelService } from './inspection-level.service';

/** omf-all-around#64 — 품목 검사 수준 지정·수동 변경(장부 P-87). */

const levelRow = (overrides: Record<string, unknown> = {}) => ({
  item_inspection_level_id: 5n,
  item_id: 10n,
  inspection_level_code: 'NORMAL',
  auto_switch_enabled: true,
  consecutive_accept_count: 7,
  updated_at: new Date('2026-10-21T00:00:00Z'),
  version_no: 3,
  item: { item_code: 'OA-001', item_name: '커버' },
  ...overrides,
});

const harness = (options: { updated?: number; item?: boolean; duplicate?: boolean } = {}) => {
  const histories: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const tx = {
    item_inspection_level: {
      create: jest.fn(async () => {
        if (options.duplicate) {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }
        return { item_inspection_level_id: 5n };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
        updates.push({ where, data });
        return { count: options.updated ?? 1 };
      }),
    },
    item_inspection_level_history: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => histories.push(data)),
    },
  };
  const prisma = {
    item: { findUnique: jest.fn().mockResolvedValue(options.item === false ? null : { item_id: 10n }) },
    item_inspection_level: { findUnique: jest.fn().mockResolvedValue(levelRow()) },
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const service = new InspectionLevelService(prisma as unknown as PrismaService);
  return { service, prisma, histories, updates };
};

describe('InspectionLevelService — 지정(POST)', () => {
  it('수준 행과 수동 이력(이전 수준 없음)을 한 트랜잭션에서 남긴다', async () => {
    const { service, histories } = harness();
    const view = await service.create({ itemId: 10, inspectionLevelCode: 'NORMAL', reason: '  OA 품목 지정 ' }, 1);

    expect(histories).toEqual([
      expect.objectContaining({
        item_id: 10,
        from_level_code: null,
        to_level_code: 'NORMAL',
        change_type_code: 'MANUAL',
        reason: 'OA 품목 지정',
        changed_by: 1,
      }),
    ]);
    expect(view).toMatchObject({ itemInspectionLevelId: 5, itemCode: 'OA-001', inspectionLevelCode: 'NORMAL', versionNo: 3 });
  });

  it.each([
    ['생략', undefined],
    ['공백', '  '],
  ])('사유가 %s 이면 그대로 지정하고 이력의 사유를 비워 둔다', async (_label, reason) => {
    const { service, histories } = harness();
    await service.create({ itemId: 10, inspectionLevelCode: 'NORMAL', reason }, 1);
    expect(histories).toEqual([expect.objectContaining({ from_level_code: null, change_type_code: 'MANUAL', reason: null })]);
  });

  it('없는 품목이면 400 itemId INVALID', async () => {
    const { service } = harness({ item: false });
    await expect(service.create({ itemId: 99, inspectionLevelCode: 'NORMAL', reason: '지정' }, 1)).rejects.toMatchObject({
      response: { errors: [expect.objectContaining({ field: 'itemId', code: 'INVALID' })] },
    });
  });

  it('이미 지정된 품목이면 400 UNIQUE_VIOLATION', async () => {
    const { service } = harness({ duplicate: true });
    const error = await service.create({ itemId: 10, inspectionLevelCode: 'NORMAL', reason: '지정' }, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractException);
    expect(error).toMatchObject({ response: { errors: [expect.objectContaining({ code: 'UNIQUE_VIOLATION', uniqueScope: ['itemId'] })] } });
  });
});

describe('InspectionLevelService — 수동 변경(PUT)', () => {
  it('수준이 바뀌면 연속 수를 0 으로 돌리고 이전→새 수준 이력을 남긴다', async () => {
    const { service, updates, histories } = harness();
    await service.update(5, 3, { inspectionLevelCode: 'TIGHTENED', reason: '고객 클레임' }, 1);

    expect(updates[0]).toMatchObject({
      where: { item_inspection_level_id: 5, version_no: 3 },
      data: { inspection_level_code: 'TIGHTENED', consecutive_accept_count: 0, updated_by: 1 },
    });
    expect(histories).toEqual([
      expect.objectContaining({ from_level_code: 'NORMAL', to_level_code: 'TIGHTENED', change_type_code: 'MANUAL', reason: '고객 클레임' }),
    ]);
  });

  it('수준이 바뀌는데 사유가 없으면 400 reason REQUIRED — 저장하지 않는다', async () => {
    const { service, prisma } = harness();
    await expect(service.update(5, 3, { inspectionLevelCode: 'REDUCED' }, 1)).rejects.toMatchObject({
      response: { errors: [expect.objectContaining({ field: 'reason', code: 'REQUIRED' })] },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('자동 전환만 끄면 사유 없이 저장하고 이력·연속 수는 그대로다', async () => {
    const { service, updates, histories } = harness();
    await service.update(5, 3, { autoSwitchEnabled: false }, 1);

    expect(updates[0].data).toMatchObject({ auto_switch_enabled: false });
    expect(updates[0].data).not.toHaveProperty('consecutive_accept_count');
    expect(histories).toEqual([]);
  });

  it('같은 수준을 다시 보내면 전환이 아니다 — 이력 없음', async () => {
    const { service, histories } = harness();
    await service.update(5, 3, { inspectionLevelCode: 'NORMAL' }, 1);
    expect(histories).toEqual([]);
  });

  it('버전이 다르면(사이에 자동 전환·다른 사용자) 409 VERSION_CONFLICT', async () => {
    const { service, histories } = harness({ updated: 0 });
    const error = await service.update(5, 2, { inspectionLevelCode: 'TIGHTENED', reason: 'x' }, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error).toMatchObject({ response: { code: 'VERSION_CONFLICT', currentVersion: '3' } });
    expect(histories).toEqual([]);
  });

  it('없는 행이면 404', async () => {
    const { service, prisma } = harness();
    prisma.item_inspection_level.findUnique.mockResolvedValueOnce(null);
    await expect(service.update(9, 1, { autoSwitchEnabled: false }, 1)).rejects.toBeInstanceOf(NotFoundException);
  });
});
