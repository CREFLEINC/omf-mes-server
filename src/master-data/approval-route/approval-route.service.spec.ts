import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { approval_route, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { ApprovalRouteService } from './approval-route.service';

const baseRoute: approval_route = {
  approval_route_id: 1n,
  approval_type_code: 'CONCESSION',
  business_unit_id: null,
  min_value: null,
  max_value: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('ApprovalRouteService', () => {
  let service: ApprovalRouteService;
  let prisma: {
    approval_route: Record<string, jest.Mock>;
    approval_route_step: Record<string, jest.Mock>;
    business_unit: Record<string, jest.Mock>;
    app_user: Record<string, jest.Mock>;
    role: Record<string, jest.Mock>;
    department: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      approval_route: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      approval_route_step: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      business_unit: { findMany: jest.fn() },
      app_user: { findUnique: jest.fn() },
      role: { findUnique: jest.fn() },
      department: { findMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApprovalRouteService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(ApprovalRouteService);
  });

  describe('create', () => {
    it('승인유형 코드값을 검증한다', async () => {
      prisma.approval_route.create.mockResolvedValue(baseRoute);

      await service.create({ approvalTypeCode: 'CONCESSION' });

      expect(codes.assertValid).toHaveBeenCalledWith('APPROVAL_TYPE', 'CONCESSION');
    });

    // 상한 < 하한이면 어떤 금액도 이 라우트를 타지 못한다.
    it('금액구간이 역전되면 400', async () => {
      await expect(
        service.create({ approvalTypeCode: 'CONCESSION', minValue: 1000, maxValue: 500 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('한쪽만 지정하면 통과한다', async () => {
      prisma.approval_route.create.mockResolvedValue(baseRoute);

      await expect(
        service.create({ approvalTypeCode: 'CONCESSION', minValue: 1000 }),
      ).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('기존 하한과 새 상한의 역전도 잡는다', async () => {
      prisma.approval_route.findUnique.mockResolvedValue({
        ...baseRoute,
        min_value: new Prisma.Decimal(1000),
      });

      await expect(service.update(1n, { maxValue: 500 })).rejects.toThrow(BadRequestException);
    });
  });

  describe('addStep — 승인자 대상은 정확히 하나', () => {
    beforeEach(() => {
      prisma.approval_route.findUnique.mockResolvedValue(baseRoute);
      prisma.approval_route_step.findUnique.mockResolvedValue(null);
      prisma.approval_route_step.create.mockResolvedValue({ approval_route_step_id: 1n });
    });

    it('아무것도 지정하지 않으면 400', async () => {
      await expect(
        service.addStep(1n, { stepNo: 1, approverTypeCode: 'ROLE' }),
      ).rejects.toThrow(/정확히 하나/);
    });

    it('둘 이상 지정하면 400', async () => {
      await expect(
        service.addStep(1n, {
          stepNo: 1,
          approverTypeCode: 'ROLE',
          approverRoleCode: 'QA_MANAGER',
          approverLoginId: 'admin',
        }),
      ).rejects.toThrow(/정확히 하나/);
    });

    // DB 제약(num_nonnulls=1)은 통과하지만 의도와 다르게 동작하는 조합이다.
    it('방식과 채운 필드가 어긋나면 400', async () => {
      await expect(
        service.addStep(1n, { stepNo: 1, approverTypeCode: 'ROLE', approverLoginId: 'admin' }),
      ).rejects.toThrow(/approverRoleCode를 채워야/);
    });

    it('알 수 없는 지정 방식이면 400', async () => {
      await expect(
        service.addStep(1n, { stepNo: 1, approverTypeCode: 'TEAM', approverRoleCode: 'X' }),
      ).rejects.toThrow(/알 수 없는 승인자 지정 방식/);
    });

    it.each([
      ['USER', { approverLoginId: 'admin' }, 'approver_user_id'],
      ['ROLE', { approverRoleCode: 'QA_MANAGER' }, 'approver_role_id'],
      ['DEPARTMENT', { approverDepartmentCode: 'QA' }, 'approver_department_id'],
    ])('%s 방식이면 해당 대상만 채운다', async (type, patch, column) => {
      prisma.app_user.findUnique.mockResolvedValue({ app_user_id: 7n });
      prisma.role.findUnique.mockResolvedValue({ role_id: 8n });
      prisma.department.findMany.mockResolvedValue([{ department_id: 9n }]);

      await service.addStep(1n, { stepNo: 1, approverTypeCode: type, ...patch });

      const data = prisma.approval_route_step.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data[column]).not.toBeNull();
      const others = ['approver_user_id', 'approver_role_id', 'approver_department_id'].filter(
        (key) => key !== column,
      );
      expect(others.every((key) => data[key] === null)).toBe(true);
    });

    it('없는 역할이면 404', async () => {
      prisma.role.findUnique.mockResolvedValue(null);

      await expect(
        service.addStep(1n, { stepNo: 1, approverTypeCode: 'ROLE', approverRoleCode: 'NOPE' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('결재 순서가 겹치면 409', async () => {
      prisma.role.findUnique.mockResolvedValue({ role_id: 8n });
      prisma.approval_route_step.findUnique.mockResolvedValue({ approval_route_step_id: 1n });

      await expect(
        service.addStep(1n, { stepNo: 1, approverTypeCode: 'ROLE', approverRoleCode: 'QA' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
