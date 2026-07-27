import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { app_user } from '@prisma/client';

import { CodeValidatorService } from '../master-data/common-code/code-validator.service';
import { OrganizationService } from '../master-data/organization/organization.service';
import { DepartmentService } from '../master-data/worker/department.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoleService } from './role.service';
import { UserService } from './user.service';

const baseUser: app_user = {
  app_user_id: 1n,
  login_id: 'hong.gildong',
  user_name: '홍길동',
  department_id: null,
  email: null,
  status_code: 'ACTIVE',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('UserService', () => {
  let service: UserService;
  let prisma: {
    app_user: Record<string, jest.Mock>;
    user_role: Record<string, jest.Mock>;
    user_data_scope: Record<string, jest.Mock>;
    role_permission: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const roles = { getRole: jest.fn() };
  const departments = { resolveId: jest.fn() };
  const org = { findBusinessUnit: jest.fn(), findPlant: jest.fn() };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    departments.resolveId.mockResolvedValue(null);
    codes.assertValid.mockResolvedValue(undefined);
    org.findBusinessUnit.mockResolvedValue({ business_unit_id: 10n });
    org.findPlant.mockResolvedValue({ plant_id: 20n });
    prisma = {
      app_user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      user_role: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), delete: jest.fn() },
      user_data_scope: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), delete: jest.fn() },
      role_permission: { findMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: prisma },
        { provide: RoleService, useValue: roles },
        { provide: DepartmentService, useValue: departments },
        { provide: OrganizationService, useValue: org },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(UserService);
  });

  describe('역할 배정', () => {
    it('비활성 역할은 부여할 수 없다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(baseUser);
      roles.getRole.mockResolvedValue({ role_id: 1n, is_active: false });

      await expect(
        service.assignRole('hong.gildong', { roleCode: 'PROD_MANAGER' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user_role.create).not.toHaveBeenCalled();
    });

    it('이미 부여된 역할이면 409', async () => {
      prisma.app_user.findUnique.mockResolvedValue(baseUser);
      roles.getRole.mockResolvedValue({ role_id: 1n, is_active: true });
      prisma.user_role.findUnique.mockResolvedValue({ user_role_id: 1n });

      await expect(
        service.assignRole('hong.gildong', { roleCode: 'PROD_MANAGER' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('유효 기능권한', () => {
    it('역할 경유로 모으고 중복을 제거한다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(baseUser);
      prisma.role_permission.findMany.mockResolvedValue([
        { permission_code: 'MASTER_READ' },
        { permission_code: 'MASTER_WRITE' },
      ]);

      await expect(service.findEffectivePermissions('hong.gildong')).resolves.toEqual([
        'MASTER_READ',
        'MASTER_WRITE',
      ]);
      expect(prisma.role_permission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ distinct: ['permission_code'] }),
      );
    });

    // 역할을 끄면 권한도 꺼져야 한다. API는 배정된 역할의 비활성화를 막지만,
    // DB에서 직접 바뀐 경우를 대비한 방어다.
    it('비활성 역할의 권한은 제외한다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(baseUser);
      prisma.role_permission.findMany.mockResolvedValue([]);

      await service.findEffectivePermissions('hong.gildong');

      expect(prisma.role_permission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: expect.objectContaining({ is_active: true }),
          }),
        }),
      );
    });
  });

  describe('데이터 접근범위', () => {
    beforeEach(() => {
      prisma.app_user.findUnique.mockResolvedValue(baseUser);
      prisma.user_data_scope.findFirst.mockResolvedValue(null);
      prisma.user_data_scope.create.mockResolvedValue({});
    });

    // DDL ck_user_data_scope_target — 사업부·공장 중 최소 하나.
    it('둘 다 없으면 400', async () => {
      await expect(
        service.addDataScope('hong.gildong', { legalEntityCode: 'OMF_VN' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('법인 없이는 사업부·공장을 특정할 수 없어 400', async () => {
      await expect(
        service.addDataScope('hong.gildong', { businessUnitCode: 'PARTS' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('사업부만 지정하면 공장은 null', async () => {
      await service.addDataScope('hong.gildong', {
        legalEntityCode: 'OMF_VN',
        businessUnitCode: 'PARTS',
      });

      expect(prisma.user_data_scope.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ business_unit_id: 10n, plant_id: null }),
      });
    });

    it('같은 조합이면 409 — DB의 COALESCE 유니크를 앱이 먼저 막는다', async () => {
      prisma.user_data_scope.findFirst.mockResolvedValue({ user_data_scope_id: 1n });

      await expect(
        service.addDataScope('hong.gildong', {
          legalEntityCode: 'OMF_VN',
          plantCode: 'PLANT1',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deactivate', () => {
    it('역할·접근범위는 지우지 않는다 — 재활성화 시 살아나야 한다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(baseUser);
      prisma.app_user.update.mockResolvedValue(baseUser);

      await service.deactivate('hong.gildong');

      expect(prisma.user_role.delete).not.toHaveBeenCalled();
      expect(prisma.user_data_scope.delete).not.toHaveBeenCalled();
      expect(prisma.app_user.update).toHaveBeenCalledWith({
        where: { app_user_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});
