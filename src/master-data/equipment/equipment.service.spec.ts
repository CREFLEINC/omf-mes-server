import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { equipment } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { OrganizationService } from '../organization/organization.service';
import { EquipmentQueryDto } from './equipment.dto';
import { EquipmentService } from './equipment.service';
import { ProductionLineService } from './production-line.service';

const baseEquipment: equipment = {
  equipment_id: 1n,
  plant_id: 1n,
  equipment_code: 'EQ_INJ_01',
  equipment_name: '사출기 1호',
  equipment_type_code: 'MACHINE',
  process_id: null,
  production_line_id: null,
  status_code: 'NORMAL',
  calibration_required: false,
  last_calibration_date: null,
  calibration_due_date: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('EquipmentService', () => {
  let service: EquipmentService;
  let prisma: {
    equipment: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    inspection_item_spec: Record<string, jest.Mock>;
    equipment_calibration: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const org = { findPlant: jest.fn() };
  const lines = { resolveForPlant: jest.fn() };
  const codes = { assertAllValid: jest.fn(), assertValid: jest.fn() };

  beforeEach(async () => {
    org.findPlant.mockResolvedValue({ plant_id: 1n, is_active: true });
    lines.resolveForPlant.mockResolvedValue(null);
    codes.assertAllValid.mockResolvedValue(undefined);
    prisma = {
      equipment: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      process: { findUnique: jest.fn() },
      inspection_item_spec: { count: jest.fn() },
      equipment_calibration: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EquipmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrganizationService, useValue: org },
        { provide: ProductionLineService, useValue: lines },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(EquipmentService);
  });

  const newEquipment = {
    legalEntityCode: 'OMF_VN',
    plantCode: 'PLANT1',
    equipmentCode: 'EQ_INJ_01',
    equipmentName: '사출기 1호',
    equipmentTypeCode: 'MACHINE',
    statusCode: 'NORMAL',
  };

  describe('create', () => {
    it('유형·상태 코드값을 검증한다', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);
      prisma.equipment.create.mockResolvedValue(baseEquipment);

      await service.create(newEquipment);

      expect(codes.assertAllValid).toHaveBeenCalledWith([
        ['EQUIPMENT_TYPE', 'MACHINE'],
        ['EQUIPMENT_STATUS', 'NORMAL'],
      ]);
    });

    it('중복이면 409', async () => {
      prisma.equipment.findUnique.mockResolvedValue(baseEquipment);

      await expect(service.create(newEquipment)).rejects.toThrow(ConflictException);
    });
  });

  // DDL에 제약이 없어 앱에서만 막는다.
  describe('교정일 정합성', () => {
    it('만료일이 최종 교정일보다 빠르면 400', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.create({
          ...newEquipment,
          lastCalibrationDate: new Date('2026-12-31'),
          calibrationDueDate: new Date('2026-01-01'),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('한쪽만 수정해도 저장될 최종 상태로 검사한다', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        { ...baseEquipment, last_calibration_date: new Date('2026-06-01') },
      ]);

      await expect(
        service.update('EQ_INJ_01', { calibrationDueDate: new Date('2026-01-01') }),
      ).rejects.toThrow(BadRequestException);
    });

    it('한쪽만 있으면 통과한다', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);
      prisma.equipment.create.mockResolvedValue(baseEquipment);

      await expect(
        service.create({ ...newEquipment, calibrationDueDate: new Date('2026-12-31') }),
      ).resolves.toBeDefined();
    });
  });

  describe('findAll', () => {
    it('교정 만료 조회는 교정 대상 설비로 한정한다', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      const query = Object.assign(new EquipmentQueryDto(), {
        page: 1,
        size: 20,
        calibrationDueBefore: new Date('2027-01-01'),
      });
      await service.findAll(query);

      expect(prisma.equipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            calibration_required: true,
            calibration_due_date: { lte: new Date('2027-01-01') },
          }),
        }),
      );
    });
  });

  describe('조회', () => {
    it('설비코드가 여러 공장에 있으면 409 — 조용히 첫 건을 고르지 않는다', async () => {
      prisma.equipment.findMany.mockResolvedValue([baseEquipment, { ...baseEquipment, plant_id: 2n }]);

      await expect(service.findOne('EQ_INJ_01')).rejects.toThrow(ConflictException);
    });
  });

  describe('deactivate', () => {
    it('검사항목 기준이 기본 검사장비로 쓰면 409', async () => {
      prisma.equipment.findMany.mockResolvedValue([baseEquipment]);
      prisma.inspection_item_spec.count.mockResolvedValue(1);

      await expect(service.deactivate('EQ_INJ_01')).rejects.toThrow(ConflictException);
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    it('참조가 없으면 is_active=false', async () => {
      prisma.equipment.findMany.mockResolvedValue([baseEquipment]);
      prisma.inspection_item_spec.count.mockResolvedValue(0);
      prisma.equipment.update.mockResolvedValue(baseEquipment);

      await service.deactivate('EQ_INJ_01');

      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { equipment_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });

  describe('addCalibration', () => {
    const dto = { calibrationDate: new Date('2026-07-01'), resultCode: 'PASS' };

    beforeEach(() => {
      prisma.equipment.findMany.mockResolvedValue([baseEquipment]);
    });

    it('검교정 결과 코드값을 검증한다', async () => {
      prisma.equipment_calibration.findUnique.mockResolvedValue(null);
      prisma.equipment_calibration.create.mockResolvedValue({ equipment_calibration_id: 1n });

      await service.addCalibration('EQ_INJ_01', dto);

      expect(codes.assertValid).toHaveBeenCalledWith('CALIBRATION_RESULT', 'PASS');
    });

    it('유효기한이 검교정일보다 빠르면 400', async () => {
      await expect(
        service.addCalibration('EQ_INJ_01', { ...dto, validUntil: new Date('2026-06-01') }),
      ).rejects.toThrow(BadRequestException);
    });

    // uq_equipment_calibration — 하루에 두 번 재면 덮어쓰는 게 아니라 거부된다.
    it('같은 날짜 기록이 있으면 409', async () => {
      prisma.equipment_calibration.findUnique.mockResolvedValue({ equipment_calibration_id: 1n });

      await expect(service.addCalibration('EQ_INJ_01', dto)).rejects.toThrow(ConflictException);
    });

    it('검교정자를 호출자로 박는다', async () => {
      prisma.equipment_calibration.findUnique.mockResolvedValue(null);
      prisma.equipment_calibration.create.mockResolvedValue({ equipment_calibration_id: 1n });

      await service.addCalibration('EQ_INJ_01', dto, 77n);

      expect(prisma.equipment_calibration.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ calibrated_by: 77n }),
      });
    });
  });
});
