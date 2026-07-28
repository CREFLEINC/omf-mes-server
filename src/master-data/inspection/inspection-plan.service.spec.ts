import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { inspection_item_spec, inspection_plan, inspection_plan_version, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { InspectionPlanQueryDto } from './inspection-plan.dto';
import { InspectionPlanService } from './inspection-plan.service';

const basePlan: inspection_plan = {
  inspection_plan_id: 1n,
  inspection_plan_code: 'IP_COVER_IQC',
  inspection_plan_name: '커버 수입검사 기준',
  item_id: null,
  process_id: null,
  routing_id: null,
  inspection_type_code: 'IQC',
  approved_by: null,
  approved_at: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const baseVersion: inspection_plan_version = {
  inspection_plan_version_id: 10n,
  inspection_plan_id: 1n,
  plan_version: 1,
  effective_from: new Date('2026-01-01'),
  effective_to: null,
  sampling_method_code: 'FULL',
  sampling_qty: null,
  aql_value: null,
  acceptance_number: null,
  rejection_number: null,
  inspection_frequency_code: 'EVERY_LOT',
  frequency_interval_value: null,
  frequency_interval_uom_code: null,
  status_code: 'DRAFT',
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const baseSpec: inspection_item_spec = {
  inspection_item_spec_id: 100n,
  inspection_plan_version_id: 10n,
  sequence_no: 10,
  inspection_item_code: 'DIM_WIDTH',
  inspection_item_name: '폭 치수',
  data_type_code: 'NUMERIC',
  uom_id: null,
  target_value: new Prisma.Decimal(100),
  lower_limit: new Prisma.Decimal(99.5),
  upper_limit: new Prisma.Decimal(100.5),
  measurement_count: 1,
  inspection_method_code: null,
  default_inspection_equipment_id: null,
  required_flag: true,
  automatic_judgment: true,
  created_at: new Date(),
  created_by: null,
};

describe('InspectionPlanService', () => {
  let service: InspectionPlanService;
  let prisma: {
    inspection_plan: Record<string, jest.Mock>;
    inspection_plan_version: Record<string, jest.Mock>;
    inspection_item_spec: Record<string, jest.Mock>;
    inspection_request: Record<string, jest.Mock>;
    inspection_measurement: Record<string, jest.Mock>;
    routing: Record<string, jest.Mock>;
    item: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    uom: Record<string, jest.Mock>;
    equipment: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    codes.assertAllValid.mockResolvedValue(undefined);
    prisma = {
      inspection_plan: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      inspection_plan_version: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      inspection_item_spec: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      inspection_request: { count: jest.fn() },
      inspection_measurement: { count: jest.fn() },
      routing: { findUnique: jest.fn() },
      item: { findUnique: jest.fn() },
      process: { findUnique: jest.fn() },
      uom: { findUnique: jest.fn() },
      equipment: { findMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InspectionPlanService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(InspectionPlanService);
  });

  describe('create', () => {
    const dto = {
      inspectionPlanCode: 'IP_COVER_IQC',
      inspectionPlanName: '커버 수입검사 기준',
      inspectionTypeCode: 'IQC',
    };

    it('검사유형 코드값을 검증한다', async () => {
      prisma.inspection_plan.findUnique.mockResolvedValue(null);
      prisma.inspection_plan.create.mockResolvedValue(basePlan);

      await service.create(dto);

      expect(codes.assertValid).toHaveBeenCalledWith('INSPECTION_TYPE', 'IQC');
    });

    it('코드가 겹치면 409', async () => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('검사유형·품목·공정 필터를 where에 넣는다', async () => {
      prisma.inspection_plan.findMany.mockResolvedValue([]);
      prisma.inspection_plan.count.mockResolvedValue(0);

      const query = Object.assign(new InspectionPlanQueryDto(), {
        page: 1,
        size: 20,
        inspectionTypeCode: 'PQC',
        itemCode: 'ITEM_0001',
        processCode: 'MOLDING',
      });
      await service.findAll(query);

      expect(prisma.inspection_plan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            inspection_type_code: 'PQC',
            item: { item_code: 'ITEM_0001' },
            process: { process_code: 'MOLDING' },
          }),
        }),
      );
    });
  });

  describe('approve', () => {
    it('승인자를 호출자로 박는다', async () => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
      prisma.inspection_plan.update.mockResolvedValue(basePlan);

      await service.approve('IP_COVER_IQC', 77n);

      expect(prisma.inspection_plan.update).toHaveBeenCalledWith({
        where: { inspection_plan_id: 1n },
        data: expect.objectContaining({ approved_by: 77n }),
      });
    });
  });

  describe('deactivate', () => {
    it('검사요청이 참조하면 409', async () => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
      prisma.inspection_request.count.mockResolvedValue(1);

      await expect(service.deactivate('IP_COVER_IQC')).rejects.toThrow(ConflictException);
      expect(prisma.inspection_plan.update).not.toHaveBeenCalled();
    });
  });

  describe('addVersion', () => {
    const dto = {
      planVersion: 1,
      statusCode: 'DRAFT',
      samplingMethodCode: 'FULL',
      inspectionFrequencyCode: 'EVERY_LOT',
      effectiveFrom: new Date('2026-01-01'),
    };

    beforeEach(() => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
    });

    it('AQL 방식인데 aqlValue가 없으면 400', async () => {
      await expect(
        service.addVersion('IP_COVER_IQC', { ...dto, samplingMethodCode: 'AQL' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('고정 샘플링인데 samplingQty가 없으면 400', async () => {
      await expect(
        service.addVersion('IP_COVER_IQC', { ...dto, samplingMethodCode: 'FIXED' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('주기 검사인데 간격이 없으면 400', async () => {
      await expect(
        service.addVersion('IP_COVER_IQC', { ...dto, inspectionFrequencyCode: 'PERIODIC' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('Re가 Ac보다 크지 않으면 400', async () => {
      await expect(
        service.addVersion('IP_COVER_IQC', { ...dto, acceptanceNumber: 2, rejectionNumber: 2 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('버전 번호가 겹치면 409', async () => {
      prisma.inspection_plan_version.findUnique.mockResolvedValue(baseVersion);

      await expect(service.addVersion('IP_COVER_IQC', dto)).rejects.toThrow(ConflictException);
    });

    it('규칙을 만족하면 등록한다', async () => {
      prisma.inspection_plan_version.findUnique.mockResolvedValue(null);
      prisma.inspection_plan_version.create.mockResolvedValue(baseVersion);

      await service.addVersion('IP_COVER_IQC', dto);

      expect(prisma.inspection_plan_version.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ plan_version: 1, sampling_method_code: 'FULL' }),
      });
    });
  });

  describe('updateVersion', () => {
    beforeEach(() => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
      prisma.inspection_plan_version.findUnique.mockResolvedValue(baseVersion);
    });

    // 기존 행은 FULL 샘플링이라 aqlValue가 없다 — 방식만 AQL로 바꾸면 규칙에 걸려야 한다.
    it('보낸 값과 기존 값을 합쳐 규칙을 다시 본다', async () => {
      await expect(
        service.updateVersion('IP_COVER_IQC', 1, { samplingMethodCode: 'AQL' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('보내지 않은 필드는 기존 값을 지킨다', async () => {
      prisma.inspection_plan_version.update.mockResolvedValue(baseVersion);

      await service.updateVersion('IP_COVER_IQC', 1, { statusCode: 'ACTIVE' });

      expect(prisma.inspection_plan_version.update).toHaveBeenCalledWith({
        where: { inspection_plan_version_id: 10n },
        data: expect.objectContaining({ status_code: 'ACTIVE', version_no: { increment: 1 } }),
      });
    });
  });

  describe('removeVersion', () => {
    beforeEach(() => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
      prisma.inspection_plan_version.findUnique.mockResolvedValue(baseVersion);
    });

    it('검사요청이 참조하면 409', async () => {
      prisma.inspection_request.count.mockResolvedValue(1);
      prisma.inspection_item_spec.count.mockResolvedValue(0);

      await expect(service.removeVersion('IP_COVER_IQC', 1)).rejects.toThrow(ConflictException);
    });

    it('검사항목이 남아 있으면 409', async () => {
      prisma.inspection_request.count.mockResolvedValue(0);
      prisma.inspection_item_spec.count.mockResolvedValue(3);

      await expect(service.removeVersion('IP_COVER_IQC', 1)).rejects.toThrow(ConflictException);
      expect(prisma.inspection_plan_version.delete).not.toHaveBeenCalled();
    });
  });

  describe('addItemSpec', () => {
    const dto = {
      sequenceNo: 10,
      inspectionItemCode: 'DIM_WIDTH',
      inspectionItemName: '폭 치수',
      dataTypeCode: 'NUMERIC',
    };

    beforeEach(() => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
      prisma.inspection_plan_version.findUnique.mockResolvedValue(baseVersion);
    });

    it('계량형 자동판정인데 상·하한이 없으면 400', async () => {
      await expect(service.addItemSpec('IP_COVER_IQC', 1, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('상한이 하한보다 작으면 400', async () => {
      await expect(
        service.addItemSpec('IP_COVER_IQC', 1, { ...dto, lowerLimit: 10, upperLimit: 5 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('계량형이 아닌데 규격값을 주면 400', async () => {
      await expect(
        service.addItemSpec('IP_COVER_IQC', 1, {
          ...dto,
          dataTypeCode: 'BOOLEAN',
          upperLimit: 5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('자동판정을 끄면 규격 없이도 등록된다', async () => {
      prisma.inspection_item_spec.findUnique.mockResolvedValue(null);
      prisma.inspection_item_spec.create.mockResolvedValue(baseSpec);

      await service.addItemSpec('IP_COVER_IQC', 1, { ...dto, automaticJudgment: false });

      expect(prisma.inspection_item_spec.create).toHaveBeenCalled();
    });

    it('항목 순서가 겹치면 409', async () => {
      prisma.inspection_item_spec.findUnique.mockResolvedValue(baseSpec);

      await expect(
        service.addItemSpec('IP_COVER_IQC', 1, { ...dto, lowerLimit: 99.5, upperLimit: 100.5 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateItemSpec / removeItemSpec', () => {
    beforeEach(() => {
      prisma.inspection_plan.findUnique.mockResolvedValue(basePlan);
      prisma.inspection_plan_version.findUnique.mockResolvedValue(baseVersion);
      prisma.inspection_item_spec.findUnique.mockResolvedValue(baseSpec);
    });

    it('측정 실적이 있으면 수정할 수 없다', async () => {
      prisma.inspection_measurement.count.mockResolvedValue(2);

      await expect(
        service.updateItemSpec('IP_COVER_IQC', 1, 10, { inspectionItemName: '폭' }),
      ).rejects.toThrow(ConflictException);
    });

    it('측정 실적이 있으면 삭제할 수 없다', async () => {
      prisma.inspection_measurement.count.mockResolvedValue(2);

      await expect(service.removeItemSpec('IP_COVER_IQC', 1, 10)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.inspection_item_spec.delete).not.toHaveBeenCalled();
    });

    it('실적이 없으면 수정된다', async () => {
      prisma.inspection_measurement.count.mockResolvedValue(0);
      prisma.inspection_item_spec.update.mockResolvedValue(baseSpec);

      await service.updateItemSpec('IP_COVER_IQC', 1, 10, { inspectionItemName: '폭' });

      expect(prisma.inspection_item_spec.update).toHaveBeenCalledWith({
        where: { inspection_item_spec_id: 100n },
        data: expect.objectContaining({ inspection_item_name: '폭' }),
      });
    });
  });
});
