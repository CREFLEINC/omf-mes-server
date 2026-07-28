import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from './numbering.service';

const globalRule = {
  numbering_rule_id: 1n,
  document_type_code: 'PRODUCTION_RESULT',
  plant_id: null,
  lot_type_code: null,
  pattern: 'PR-{YYMMDD}-{SEQ4}',
  reset_cycle_code: 'DAILY',
  is_active: true,
};

const plantRule = { ...globalRule, numbering_rule_id: 2n, plant_id: 2n, pattern: 'PR-{PLANT}-{SEQ4}' };

/** 베트남 공장 기준 2026-07-29 00:30 = UTC 2026-07-28 17:30. */
const ACROSS_MIDNIGHT = new Date('2026-07-28T17:30:00Z');

describe('NumberingService', () => {
  let service: NumberingService;
  let prisma: {
    numbering_rule: Record<string, jest.Mock>;
    plant: Record<string, jest.Mock>;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      numbering_rule: { findMany: jest.fn().mockResolvedValue([globalRule]) },
      plant: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ plant_code: 'PLANT_1', timezone_code: 'Asia/Ho_Chi_Minh' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ last_value: 1n }]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [NumberingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(NumberingService);
  });

  it('패턴의 날짜·일련번호 토큰을 채운다', async () => {
    const issued = await service.issue('PRODUCTION_RESULT', {
      on: new Date('2026-07-28T09:00:00Z'),
    });

    expect(issued).toBe('PR-260728-0001');
  });

  it('일련번호를 자릿수만큼 0으로 채운다', async () => {
    prisma.$queryRaw.mockResolvedValue([{ last_value: 42n }]);

    const issued = await service.issue('PRODUCTION_RESULT', {
      on: new Date('2026-07-28T09:00:00Z'),
    });

    expect(issued).toBe('PR-260728-0042');
  });

  // 서버가 UTC면 현지 00:30에 뽑은 번호가 전날 날짜를 달고 나간다. 번호는 되돌릴 수 없다.
  it('날짜 토큰을 공장 현지 시각으로 끊는다', async () => {
    const issued = await service.issue('PRODUCTION_RESULT', {
      plantId: 2n,
      on: ACROSS_MIDNIGHT,
    });

    expect(issued).toBe('PR-260729-0001');
  });

  it('공장을 모르면 UTC로 끊는다', async () => {
    prisma.plant.findUnique.mockResolvedValue(null);

    const issued = await service.issue('PRODUCTION_RESULT', { on: ACROSS_MIDNIGHT });

    expect(issued).toBe('PR-260728-0001');
  });

  it('공장 지정 규칙이 전역 규칙을 이긴다', async () => {
    prisma.numbering_rule.findMany.mockResolvedValue([globalRule, plantRule]);

    const issued = await service.issue('PRODUCTION_RESULT', { plantId: 2n });

    expect(issued).toBe('PR-PLANT_1-0001');
  });

  it('규칙이 없으면 404', async () => {
    prisma.numbering_rule.findMany.mockResolvedValue([]);

    await expect(service.issue('PRODUCTION_RESULT')).rejects.toThrow(NotFoundException);
  });

  // {PLNAT} 같은 오타를 그대로 내보내면 업무 번호에 중괄호가 박힌 채 영구히 남는다.
  it('모르는 토큰이 있으면 던진다', async () => {
    prisma.numbering_rule.findMany.mockResolvedValue([{ ...globalRule, pattern: 'PR-{PLNAT}' }]);

    await expect(service.issue('PRODUCTION_RESULT')).rejects.toThrow(BadRequestException);
  });

  it('알 수 없는 리셋주기면 던진다', async () => {
    prisma.numbering_rule.findMany.mockResolvedValue([
      { ...globalRule, reset_cycle_code: 'WEEKLY' },
    ]);

    await expect(service.issue('PRODUCTION_RESULT')).rejects.toThrow(BadRequestException);
  });

  describe('카운터 키', () => {
    // 태그드 템플릿이라 인자는 [템플릿 문자열, numbering_rule_id, period_key] 순이다.
    const periodKeyOf = () => String(prisma.$queryRaw.mock.calls[0][2]);

    it.each([
      ['DAILY', '20260728'],
      ['MONTHLY', '202607'],
      ['YEARLY', '2026'],
      ['NONE', 'ALL'],
    ])('%s 주기는 카운터를 %s로 가른다', async (cycle, expected) => {
      prisma.numbering_rule.findMany.mockResolvedValue([
        { ...globalRule, reset_cycle_code: cycle, pattern: '{SEQ4}' },
      ]);

      await service.issue('PRODUCTION_RESULT', { on: new Date('2026-07-28T09:00:00Z') });

      expect(periodKeyOf()).toBe(expected);
    });
  });
});
