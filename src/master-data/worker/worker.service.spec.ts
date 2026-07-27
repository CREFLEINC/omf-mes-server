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
      worker: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
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
