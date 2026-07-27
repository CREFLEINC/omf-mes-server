import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mold } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { OrganizationService } from '../organization/organization.service';
import { MoldQueryDto } from './mold.dto';
import { MoldService } from './mold.service';

const baseMold: mold = {
  mold_id: 1n,
  plant_id: 1n,
  mold_code: 'MOLD_A01',
  mold_name: '커버 상형',
  cavity_count: 4,
  guaranteed_shot_count: 500000n,
  current_shot_count: 0n,
  status_code: 'NORMAL',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('MoldService', () => {
  let service: MoldService;
  let prisma: {
    mold: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const org = { findPlant: jest.fn() };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    org.findPlant.mockResolvedValue({ plant_id: 1n, is_active: true });
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      mold: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MoldService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrganizationService, useValue: org },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(MoldService);
  });

  const newMold = {
    legalEntityCode: 'OMF_VN',
    plantCode: 'PLANT1',
    moldCode: 'MOLD_A01',
    moldName: '커버 상형',
    statusCode: 'NORMAL',
  };

  describe('create', () => {
    it('상태 코드값을 검증한다', async () => {
      prisma.mold.findUnique.mockResolvedValue(null);
      prisma.mold.create.mockResolvedValue(baseMold);

      await service.create(newMold);

      expect(codes.assertValid).toHaveBeenCalledWith('MOLD_STATUS', 'NORMAL');
    });

    it('Cavity 1·누적 타발수 0을 기본값으로 채운다', async () => {
      prisma.mold.findUnique.mockResolvedValue(null);
      prisma.mold.create.mockResolvedValue(baseMold);

      await service.create(newMold);

      expect(prisma.mold.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ cavity_count: 1, current_shot_count: 0 }),
      });
    });

    it('DX 이관용 누적 타발수 초기값을 받는다', async () => {
      prisma.mold.findUnique.mockResolvedValue(null);
      prisma.mold.create.mockResolvedValue(baseMold);

      await service.create({ ...newMold, currentShotCount: 280000 });

      expect(prisma.mold.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ current_shot_count: 280000 }),
      });
    });

    it('중복이면 409', async () => {
      prisma.mold.findUnique.mockResolvedValue(baseMold);

      await expect(service.create(newMold)).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('누적 타발수 하한을 gte 조건으로 건다', async () => {
      prisma.mold.findMany.mockResolvedValue([]);
      prisma.mold.count.mockResolvedValue(0);

      const query = Object.assign(new MoldQueryDto(), { page: 1, size: 20, shotCountGte: 200000 });
      await service.findAll(query);

      expect(prisma.mold.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ current_shot_count: { gte: 200000 } }),
        }),
      );
    });

    it('shotCountGte=0도 필터로 취급한다 — falsy라고 버리지 않는다', async () => {
      prisma.mold.findMany.mockResolvedValue([]);
      prisma.mold.count.mockResolvedValue(0);

      const query = Object.assign(new MoldQueryDto(), { page: 1, size: 20, shotCountGte: 0 });
      await service.findAll(query);

      expect(prisma.mold.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ current_shot_count: { gte: 0 } }),
        }),
      );
    });
  });

  describe('조회', () => {
    it('없으면 404', async () => {
      prisma.mold.findMany.mockResolvedValue([]);

      await expect(service.findOne('ZZZ')).rejects.toThrow(NotFoundException);
    });

    it('금형코드가 여러 공장에 있으면 409', async () => {
      prisma.mold.findMany.mockResolvedValue([baseMold, { ...baseMold, plant_id: 2n }]);

      await expect(service.findOne('MOLD_A01')).rejects.toThrow(ConflictException);
    });
  });

  describe('deactivate', () => {
    it('is_active=false로 만든다', async () => {
      prisma.mold.findMany.mockResolvedValue([baseMold]);
      prisma.mold.update.mockResolvedValue(baseMold);

      await service.deactivate('MOLD_A01');

      expect(prisma.mold.update).toHaveBeenCalledWith({
        where: { mold_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});
