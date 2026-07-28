import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { numbering_rule } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { NumberingRuleService } from './numbering-rule.service';

const baseRule: numbering_rule = {
  numbering_rule_id: 1n,
  document_type_code: 'WORK_ORDER',
  plant_id: null,
  lot_type_code: null,
  pattern: 'WO-{PLANT}-{YYMMDD}-{SEQ4}',
  reset_cycle_code: 'DAILY',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('NumberingRuleService', () => {
  let service: NumberingRuleService;
  let prisma: {
    numbering_rule: Record<string, jest.Mock>;
    numbering_counter: Record<string, jest.Mock>;
    plant: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    codes.assertAllValid.mockResolvedValue(undefined);
    prisma = {
      numbering_rule: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      numbering_counter: { findMany: jest.fn(), count: jest.fn() },
      plant: { findMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NumberingRuleService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(NumberingRuleService);
  });

  const dto = { documentTypeCode: 'WORK_ORDER', pattern: 'WO-{PLANT}-{YYMMDD}-{SEQ4}' };

  describe('패턴 검증', () => {
    beforeEach(() => {
      prisma.numbering_rule.findFirst.mockResolvedValue(null);
      prisma.numbering_rule.create.mockResolvedValue(baseRule);
    });

    it.each([
      ['WO-{PLANT}-{YYMMDD}-{SEQ4}'],
      ['LOT{YYYYMMDD}{SEQ6}'],
      ['{DOC}-{YY}{MM}{DD}-{SEQ3}'],
    ])('유효한 패턴은 통과한다: %s', async (pattern) => {
      await expect(service.create({ ...dto, pattern })).resolves.toBeDefined();
    });

    // 오타는 발번 시작 전에 잡아야 한다.
    it('알 수 없는 토큰이면 400', async () => {
      await expect(service.create({ ...dto, pattern: 'WO-{FACTORY}-{SEQ4}' })).rejects.toThrow(
        /알 수 없는 패턴 토큰/,
      );
    });

    it('일련번호 토큰이 2개면 400', async () => {
      await expect(service.create({ ...dto, pattern: 'WO-{SEQ4}-{SEQ2}' })).rejects.toThrow(
        /정확히 1개/,
      );
    });

    it('자리수가 과하면 400', async () => {
      await expect(service.create({ ...dto, pattern: 'WO-{SEQ99}' })).rejects.toThrow(/자리수/);
    });
  });

  describe('create', () => {
    it('문서유형·리셋주기 코드값을 검증한다', async () => {
      prisma.numbering_rule.findFirst.mockResolvedValue(null);
      prisma.numbering_rule.create.mockResolvedValue(baseRule);

      await service.create({ ...dto, resetCycleCode: 'MONTHLY' });

      expect(codes.assertAllValid).toHaveBeenCalledWith([
        ['DOCUMENT_TYPE', 'WORK_ORDER'],
        ['RESET_CYCLE', 'MONTHLY'],
      ]);
    });

    it('기본 리셋주기는 DAILY다', async () => {
      prisma.numbering_rule.findFirst.mockResolvedValue(null);
      prisma.numbering_rule.create.mockResolvedValue(baseRule);

      await service.create(dto);

      expect(prisma.numbering_rule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reset_cycle_code: 'DAILY' }),
      });
    });

    it('문서유형×공장×LOT유형이 겹치면 409', async () => {
      prisma.numbering_rule.findFirst.mockResolvedValue(baseRule);

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    // 발번이 시작된 뒤 패턴을 바꾸면 같은 규칙에서 형식이 다른 번호가 섞인다.
    it.each([
      ['패턴', { pattern: 'WO-{SEQ6}' }],
      ['리셋주기', { resetCycleCode: 'MONTHLY' }],
    ])('발번이 시작됐으면 %s를 바꿀 수 없다', async (_label, patch) => {
      prisma.numbering_rule.findUnique.mockResolvedValue(baseRule);
      prisma.numbering_counter.count.mockResolvedValue(3);

      await expect(service.update(1n, patch)).rejects.toThrow(ConflictException);
      expect(prisma.numbering_rule.update).not.toHaveBeenCalled();
    });

    it('카운터가 없으면 패턴을 바꿀 수 있다', async () => {
      prisma.numbering_rule.findUnique.mockResolvedValue(baseRule);
      prisma.numbering_counter.count.mockResolvedValue(0);
      prisma.numbering_rule.update.mockResolvedValue(baseRule);

      await service.update(1n, { pattern: 'WO-{SEQ6}' });

      expect(prisma.numbering_rule.update).toHaveBeenCalled();
    });

    // 사용여부만 끄는 건 발번 이력과 무관하다.
    it('발번이 시작됐어도 비활성화는 막지 않는다', async () => {
      prisma.numbering_rule.findUnique.mockResolvedValue(baseRule);
      prisma.numbering_rule.update.mockResolvedValue(baseRule);

      await service.update(1n, { isActive: false });

      expect(prisma.numbering_counter.count).not.toHaveBeenCalled();
      expect(prisma.numbering_rule.update).toHaveBeenCalled();
    });

    it('잘못된 패턴으로는 바꿀 수 없다', async () => {
      prisma.numbering_rule.findUnique.mockResolvedValue(baseRule);

      await expect(service.update(1n, { pattern: 'WO-{NOPE}-{SEQ4}' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
