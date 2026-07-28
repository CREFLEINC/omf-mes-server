import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { operation_policy, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { OperationPolicyQueryDto } from './operation-policy.dto';
import { OperationPolicyService } from './operation-policy.service';

const basePolicy: operation_policy = {
  operation_policy_id: 1n,
  policy_code: 'FIFO_VIOLATION_POLICY',
  business_unit_id: null,
  plant_id: null,
  item_id: null,
  process_id: null,
  value_text: 'WARN',
  value_numeric: null,
  value_boolean: null,
  effective_from: new Date('2026-01-01'),
  effective_to: null,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('OperationPolicyService', () => {
  let service: OperationPolicyService;
  let prisma: {
    operation_policy: Record<string, jest.Mock>;
    business_unit: Record<string, jest.Mock>;
    plant: Record<string, jest.Mock>;
    item: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      operation_policy: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      business_unit: { findMany: jest.fn() },
      plant: { findMany: jest.fn() },
      item: { findUnique: jest.fn() },
      process: { findUnique: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OperationPolicyService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(OperationPolicyService);
  });

  const createDto = {
    policyCode: 'FIFO_VIOLATION_POLICY',
    valueText: 'WARN',
    effectiveFrom: new Date('2026-01-01'),
  };

  describe('create', () => {
    it('정책코드를 OPERATION_POLICY로 검증한다', async () => {
      prisma.operation_policy.findFirst.mockResolvedValue(null);
      prisma.operation_policy.create.mockResolvedValue(basePolicy);

      await service.create(createDto);

      expect(codes.assertValid).toHaveBeenCalledWith('OPERATION_POLICY', 'FIFO_VIOLATION_POLICY');
    });

    // DDL의 ck_operation_policy_value — 값 3종 중 하나는 있어야 한다.
    it('값이 하나도 없으면 400', async () => {
      await expect(
        service.create({ policyCode: 'X', effectiveFrom: new Date('2026-01-01') }),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      ['수치값', { valueNumeric: 5 }],
      ['불리언값', { valueBoolean: true }],
      ['false도 값이다', { valueBoolean: false }],
    ])('%s만 있어도 등록된다', async (_label, value) => {
      prisma.operation_policy.findFirst.mockResolvedValue(null);
      prisma.operation_policy.create.mockResolvedValue(basePolicy);

      await service.create({
        policyCode: 'X',
        effectiveFrom: new Date('2026-01-01'),
        ...value,
      });

      expect(prisma.operation_policy.create).toHaveBeenCalled();
    });

    it('스코프를 지정하지 않으면 전부 null(전역)이다', async () => {
      prisma.operation_policy.findFirst.mockResolvedValue(null);
      prisma.operation_policy.create.mockResolvedValue(basePolicy);

      await service.create(createDto);

      expect(prisma.operation_policy.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_unit_id: null,
          plant_id: null,
          item_id: null,
          process_id: null,
        }),
      });
    });

    it('같은 스코프·시작일이 있으면 409', async () => {
      prisma.operation_policy.findFirst.mockResolvedValue(basePolicy);

      await expect(service.create(createDto)).rejects.toThrow(ConflictException);
    });

    it('공장 코드가 여러 법인에 있으면 409', async () => {
      prisma.plant.findMany.mockResolvedValue([{ plant_id: 1n }, { plant_id: 2n }]);

      await expect(service.create({ ...createDto, plantCode: 'P1' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('없는 품목을 스코프로 주면 404', async () => {
      prisma.item.findUnique.mockResolvedValue(null);

      await expect(service.create({ ...createDto, itemCode: 'NOPE' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    // 기준일에 유효한 정책 = 시작일 이전 + (종료일 없음 또는 기준일 이후)
    it('기준일 필터는 유효기간을 함께 본다', async () => {
      prisma.operation_policy.findMany.mockResolvedValue([]);
      prisma.operation_policy.count.mockResolvedValue(0);

      const query = Object.assign(new OperationPolicyQueryDto(), {
        page: 1,
        size: 20,
        effectiveOn: new Date('2026-06-01'),
      });
      await service.findAll(query);

      expect(prisma.operation_policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            effective_from: { lte: new Date('2026-06-01') },
            OR: [{ effective_to: null }, { effective_to: { gte: new Date('2026-06-01') } }],
          }),
        }),
      );
    });
  });

  describe('update', () => {
    it('값 3종을 모두 지우려 하면 400', async () => {
      prisma.operation_policy.findUnique.mockResolvedValue({
        ...basePolicy,
        value_text: null,
        value_numeric: null,
        value_boolean: null,
      });

      await expect(service.update(1n, { valueText: undefined })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('기존 값이 남아 있으면 통과한다', async () => {
      prisma.operation_policy.findUnique.mockResolvedValue(basePolicy);
      prisma.operation_policy.update.mockResolvedValue(basePolicy);

      await service.update(1n, { effectiveTo: new Date('2026-12-31') });

      expect(prisma.operation_policy.update).toHaveBeenCalledWith({
        where: { operation_policy_id: 1n },
        data: expect.objectContaining({ version_no: { increment: 1 } }),
      });
    });

    it('기존 시작일보다 빠른 종료일이면 400', async () => {
      prisma.operation_policy.findUnique.mockResolvedValue(basePolicy);

      await expect(service.update(1n, { effectiveTo: new Date('2025-06-01') })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('수치값 0도 값으로 인정한다', async () => {
      prisma.operation_policy.findUnique.mockResolvedValue({
        ...basePolicy,
        value_text: null,
        value_numeric: new Prisma.Decimal(0),
      });
      prisma.operation_policy.update.mockResolvedValue(basePolicy);

      await expect(service.update(1n, {})).resolves.toBeDefined();
    });
  });

  describe('expire', () => {
    // is_active가 없다 — 이력이 필요한 값이라 물리 삭제 대신 종료일을 닫는다.
    it('삭제하지 않고 종료일을 채운다', async () => {
      prisma.operation_policy.findUnique.mockResolvedValue(basePolicy);
      prisma.operation_policy.update.mockResolvedValue(basePolicy);

      await service.expire(1n);

      const call = prisma.operation_policy.update.mock.calls[0][0] as {
        data: { effective_to: Date };
      };
      expect(call.data.effective_to).toBeInstanceOf(Date);
    });
  });
});
