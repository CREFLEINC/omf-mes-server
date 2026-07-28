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

  describe('resolve — 겹치는 정책 중 무엇이 이기나', () => {
    /** 스코프만 다른 후보들을 준다. 서비스가 그중 하나를 골라야 한다. */
    const candidates = (...rows: Partial<operation_policy>[]) =>
      prisma.operation_policy.findMany.mockResolvedValue(
        rows.map((row, i) => ({ ...basePolicy, operation_policy_id: BigInt(i + 1), ...row })),
      );

    it('후보가 없으면 null', async () => {
      candidates();

      await expect(service.resolve('FIFO_VIOLATION_POLICY')).resolves.toBeNull();
    });

    // 전역 OFF · 1공장 WARN · 1공장+사출 BLOCK 이 모두 해당될 때
    it('구체적일수록 이긴다', async () => {
      candidates(
        { value_text: 'OFF' },
        { value_text: 'WARN', plant_id: 2n },
        { value_text: 'BLOCK', plant_id: 2n, process_id: 3n },
      );

      const found = await service.resolve('FIFO_VIOLATION_POLICY', {
        plantId: 2n,
        processId: 3n,
      });

      expect(found?.value_text).toBe('BLOCK');
    });

    it('공정이 품목보다 우선한다', async () => {
      candidates({ value_text: 'ITEM', item_id: 5n }, { value_text: 'PROCESS', process_id: 3n });

      const found = await service.resolve('X', { itemId: 5n, processId: 3n });

      expect(found?.value_text).toBe('PROCESS');
    });

    it('품목이 공장보다 우선한다', async () => {
      candidates({ value_text: 'PLANT', plant_id: 2n }, { value_text: 'ITEM', item_id: 5n });

      const found = await service.resolve('X', { plantId: 2n, itemId: 5n });

      expect(found?.value_text).toBe('ITEM');
    });

    // 같은 축 조합은 시작일만 다르다(uq_operation_policy).
    it('같은 스코프면 늦은 시작일이 이긴다', async () => {
      candidates(
        { value_text: 'OLD', plant_id: 2n, effective_from: new Date('2026-01-01') },
        { value_text: 'NEW', plant_id: 2n, effective_from: new Date('2026-06-01') },
      );

      const found = await service.resolve('X', { plantId: 2n });

      expect(found?.value_text).toBe('NEW');
    });

    it('축을 주면 그 값 또는 전역 행만 후보로 넣는다', async () => {
      candidates({ value_text: 'OFF' });

      await service.resolve('X', { plantId: 2n });

      const where = prisma.operation_policy.findMany.mock.calls[0][0].where as {
        AND: unknown[];
      };
      expect(where.AND).toContainEqual({ OR: [{ plant_id: 2n }, { plant_id: null }] });
    });

    // 적용 대상인지 확인할 수 없는 정책을 적용하면 안 된다.
    it('축을 주지 않으면 그 축이 지정된 행은 후보에서 뺀다', async () => {
      candidates({ value_text: 'OFF' });

      await service.resolve('X', {});

      const where = prisma.operation_policy.findMany.mock.calls[0][0].where as {
        AND: unknown[];
      };
      expect(where.AND).toContainEqual({ item_id: null });
    });

    it('유효기간이 지난 정책은 후보에서 뺀다', async () => {
      candidates({ value_text: 'OFF' });

      await service.resolve('X', { on: new Date('2026-06-01') });

      const where = prisma.operation_policy.findMany.mock.calls[0][0].where as {
        effective_from: unknown;
        AND: unknown[];
      };
      expect(where.effective_from).toEqual({ lte: new Date('2026-06-01') });
      expect(where.AND).toContainEqual({
        OR: [{ effective_to: null }, { effective_to: { gte: new Date('2026-06-01') } }],
      });
    });
  });

  describe('타입별 조회', () => {
    it('정책이 없으면 fallback을 돌려준다', async () => {
      prisma.operation_policy.findMany.mockResolvedValue([]);

      await expect(service.resolveText('X', 'OFF')).resolves.toBe('OFF');
      await expect(service.resolveNumber('X', 5)).resolves.toBe(5);
      await expect(service.resolveBoolean('X', false)).resolves.toBe(false);
    });

    it('값이 있으면 그 값을 돌려준다', async () => {
      prisma.operation_policy.findMany.mockResolvedValue([
        { ...basePolicy, value_text: 'BLOCK', value_numeric: new Prisma.Decimal(7), value_boolean: true },
      ]);

      await expect(service.resolveText('X', 'OFF')).resolves.toBe('BLOCK');
      await expect(service.resolveNumber('X', 5)).resolves.toBe(7);
      await expect(service.resolveBoolean('X', false)).resolves.toBe(true);
    });

    // 정책값 false가 fallback true로 덮이면 설정이 무시된다.
    it('불리언 false를 fallback으로 덮지 않는다', async () => {
      prisma.operation_policy.findMany.mockResolvedValue([
        { ...basePolicy, value_boolean: false },
      ]);

      await expect(service.resolveBoolean('X', true)).resolves.toBe(false);
    });
  });
});
