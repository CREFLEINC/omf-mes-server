import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { worker } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { OrganizationService } from '../organization/organization.service';
import { DepartmentService } from './department.service';
import { QualificationQueryDto } from './worker.dto';
import { WorkerService } from './worker.service';

const baseWorker: worker = {
  worker_id: 1n,
  worker_no: 'W0001',
  worker_name: '홍길동',
  business_unit_id: 1n,
  plant_id: 1n,
  department_id: null,
  app_user_id: null,
  status_code: 'ACTIVE',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('WorkerService', () => {
  let service: WorkerService;
  let prisma: {
    worker: Record<string, jest.Mock>;
    app_user: Record<string, jest.Mock>;
    worker_qualification: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const org = { findPlant: jest.fn(), findBusinessUnit: jest.fn() };
  const departments = { resolveId: jest.fn() };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    org.findPlant.mockResolvedValue({ plant_id: 1n });
    org.findBusinessUnit.mockResolvedValue({ business_unit_id: 1n });
    departments.resolveId.mockResolvedValue(null);
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      worker: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      app_user: { findUnique: jest.fn() },
      worker_qualification: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), delete: jest.fn() },
      process: { findUnique: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkerService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrganizationService, useValue: org },
        { provide: DepartmentService, useValue: departments },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(WorkerService);
  });

  const newWorker = {
    workerNo: 'W0001',
    workerName: '홍길동',
    legalEntityCode: 'OMF_VN',
    businessUnitCode: 'PARTS',
    plantCode: 'PLANT1',
    statusCode: 'ACTIVE',
  };

  describe('create', () => {
    it('재직 상태 코드값을 검증한다', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      prisma.worker.create.mockResolvedValue(baseWorker);

      await service.create(newWorker);

      expect(codes.assertValid).toHaveBeenCalledWith('WORKER_STATUS', 'ACTIVE');
    });

    it('사번이 중복이면 409', async () => {
      prisma.worker.findUnique.mockResolvedValue(baseWorker);

      await expect(service.create(newWorker)).rejects.toThrow(ConflictException);
    });
  });

  describe('자격', () => {
    beforeEach(() => {
      prisma.worker.findUnique.mockResolvedValue(baseWorker);
      prisma.worker_qualification.findFirst.mockResolvedValue(null);
      prisma.worker_qualification.create.mockResolvedValue({});
    });

    it('유효기간이 역전되면 400', async () => {
      await expect(
        service.addQualification('W0001', {
          qualificationTypeCode: 'INSPECTOR',
          validFrom: new Date('2026-12-31'),
          validTo: new Date('2026-01-01'),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('종료일이 없으면 무기한으로 등록된다', async () => {
      await service.addQualification('W0001', {
        qualificationTypeCode: 'INSPECTOR',
        validFrom: new Date('2026-01-01'),
      });

      expect(prisma.worker_qualification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ valid_to: null, process_id: null }),
      });
    });

    it('같은 (유형·공정·시작일)이면 409 — DB의 COALESCE 유니크를 앱이 먼저 막는다', async () => {
      prisma.worker_qualification.findFirst.mockResolvedValue({ worker_qualification_id: 1n });

      await expect(
        service.addQualification('W0001', {
          qualificationTypeCode: 'INSPECTOR',
          validFrom: new Date('2026-01-01'),
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('없는 공정이면 404', async () => {
      prisma.process.findUnique.mockResolvedValue(null);

      await expect(
        service.addQualification('W0001', {
          qualificationTypeCode: 'PROCESS_OPERATION',
          processCode: 'ZZZ',
          validFrom: new Date('2026-01-01'),
        }),
      ).rejects.toThrow(NotFoundException);
    });

    // NFR-QM-008 자격 만료 시 확정 제한의 기반 조회.
    it('validOn은 시작일 이전 + (종료일 없음 또는 종료일 이후)로 건다', async () => {
      prisma.worker_qualification.findMany.mockResolvedValue([]);

      const query = Object.assign(new QualificationQueryDto(), {
        validOn: new Date('2026-06-01'),
      });
      await service.findQualifications('W0001', query);

      expect(prisma.worker_qualification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            valid_from: { lte: new Date('2026-06-01') },
            OR: [{ valid_to: null }, { valid_to: { gte: new Date('2026-06-01') } }],
          }),
        }),
      );
    });
  });

  // 개념모델 §5.10·§5.15 — 작업자(현장 수행 주체)와 사용자(시스템 입력 주체)는 별개이고
  // 1:1로 강제하지 않는다. 다만 계정 하나는 한 사람이라 여러 작업자에 붙일 수 없다.
  describe('관리 화면 계정 연결', () => {
    beforeEach(() => {
      prisma.worker.findUnique.mockResolvedValue(null);
      prisma.worker.create.mockResolvedValue(baseWorker);
      prisma.app_user.findUnique.mockResolvedValue({ app_user_id: 7n });
      prisma.worker.findFirst.mockResolvedValue(null);
    });

    it('로그인 ID를 계정 FK로 바꿔 저장한다', async () => {
      await service.create({ ...newWorker, appUserLoginId: 'hong.gildong' });

      expect(prisma.worker.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ app_user_id: 7n }),
      });
    });

    it('미지정이면 연결하지 않는다', async () => {
      await service.create(newWorker);

      expect(prisma.worker.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ app_user_id: null }),
      });
      expect(prisma.app_user.findUnique).not.toHaveBeenCalled();
    });

    it('없는 계정이면 404', async () => {
      prisma.app_user.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ ...newWorker, appUserLoginId: 'nobody' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('이미 다른 작업자에 연결된 계정이면 409', async () => {
      prisma.worker.findFirst.mockResolvedValue({ worker_no: 'W9999' });

      await expect(
        service.create({ ...newWorker, appUserLoginId: 'hong.gildong' }),
      ).rejects.toThrow(ConflictException);
    });

    it('수정 시 자기 자신은 중복으로 보지 않는다', async () => {
      prisma.worker.findUnique.mockResolvedValue(baseWorker);
      prisma.worker.update.mockResolvedValue(baseWorker);

      await service.update('W0001', { appUserLoginId: 'hong.gildong' });

      // 중복 검사에서 자기 worker_id를 제외해야 한다.
      expect(prisma.worker.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ worker_id: { not: 1n } }),
        }),
      );
      expect(prisma.worker.update).toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('보유 자격이 있어도 비활성화를 막지 않는다 — 자격은 이력이다', async () => {
      prisma.worker.findUnique.mockResolvedValue(baseWorker);
      prisma.worker.update.mockResolvedValue(baseWorker);

      await service.deactivate('W0001');

      expect(prisma.worker.update).toHaveBeenCalledWith({
        where: { worker_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});
