import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { partner } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { PartnerQueryDto } from './partner.dto';
import { PartnerService } from './partner.service';

const basePartner: partner = {
  partner_id: 1n,
  partner_code: 'SUP_0001',
  partner_name: '한독 정밀',
  country_code: 'VNM',
  erp_partner_code: 'EP-1001',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('PartnerService', () => {
  let service: PartnerService;
  let prisma: {
    partner: Record<string, jest.Mock>;
    partner_role: Record<string, jest.Mock>;
    warehouse: Record<string, jest.Mock>;
    item_external_code: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertAllValid: jest.fn(), assertValid: jest.fn() };

  beforeEach(async () => {
    codes.assertAllValid.mockResolvedValue(undefined);
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      partner: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      partner_role: { findUnique: jest.fn(), create: jest.fn() },
      warehouse: { count: jest.fn() },
      item_external_code: { count: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(PartnerService);
  });

  describe('create', () => {
    it('역할을 함께 생성한다', async () => {
      prisma.partner.findUnique.mockResolvedValue(null);
      prisma.partner.create.mockResolvedValue(basePartner);

      await service.create({
        partnerCode: 'SUP_0001',
        partnerName: '한독 정밀',
        roleTypeCodes: ['SUPPLIER', 'CARRIER'],
      });

      expect(prisma.partner.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          partner_role: {
            create: [
              expect.objectContaining({ role_type_code: 'SUPPLIER' }),
              expect.objectContaining({ role_type_code: 'CARRIER' }),
            ],
          },
        }),
      });
    });

    it('중복 역할은 한 번만 만든다 — uq_partner_role 위반을 피한다', async () => {
      prisma.partner.findUnique.mockResolvedValue(null);
      prisma.partner.create.mockResolvedValue(basePartner);

      await service.create({
        partnerCode: 'SUP_0001',
        partnerName: 'x',
        roleTypeCodes: ['SUPPLIER', 'SUPPLIER'],
      });

      const arg = prisma.partner.create.mock.calls[0][0];
      expect(arg.data.partner_role.create).toHaveLength(1);
    });

    it('역할 코드값을 검증한다', async () => {
      prisma.partner.findUnique.mockResolvedValue(null);
      prisma.partner.create.mockResolvedValue(basePartner);

      await service.create({ partnerCode: 'P', partnerName: 'x', roleTypeCodes: ['SUPPLIER'] });

      expect(codes.assertAllValid).toHaveBeenCalledWith([['PARTNER_ROLE_TYPE', 'SUPPLIER']]);
    });

    it('중복 거래처면 409', async () => {
      prisma.partner.findUnique.mockResolvedValue(basePartner);

      await expect(service.create({ partnerCode: 'SUP_0001', partnerName: 'x' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findAll', () => {
    it('역할 필터를 관계 조건으로 건다', async () => {
      prisma.partner.findMany.mockResolvedValue([]);
      prisma.partner.count.mockResolvedValue(0);

      const query = Object.assign(new PartnerQueryDto(), {
        page: 1,
        size: 20,
        roleTypeCode: 'SUPPLIER',
      });
      await service.findAll(query);

      expect(prisma.partner.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            partner_role: { some: { role_type_code: 'SUPPLIER' } },
          }),
        }),
      );
    });
  });

  describe('deactivate', () => {
    it('외부창고가 참조하면 409', async () => {
      prisma.partner.findUnique.mockResolvedValue(basePartner);
      prisma.warehouse.count.mockResolvedValue(1);
      prisma.item_external_code.count.mockResolvedValue(0);

      await expect(service.deactivate('SUP_0001')).rejects.toThrow(ConflictException);
      expect(prisma.partner.update).not.toHaveBeenCalled();
    });

    it('품목 외부코드가 참조해도 409', async () => {
      prisma.partner.findUnique.mockResolvedValue(basePartner);
      prisma.warehouse.count.mockResolvedValue(0);
      prisma.item_external_code.count.mockResolvedValue(2);

      await expect(service.deactivate('SUP_0001')).rejects.toThrow(ConflictException);
    });

    it('참조가 없으면 is_active=false', async () => {
      prisma.partner.findUnique.mockResolvedValue(basePartner);
      prisma.warehouse.count.mockResolvedValue(0);
      prisma.item_external_code.count.mockResolvedValue(0);
      prisma.partner.update.mockResolvedValue(basePartner);

      await service.deactivate('SUP_0001');

      expect(prisma.partner.update).toHaveBeenCalledWith({
        where: { partner_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });

    it('없는 거래처면 404', async () => {
      prisma.partner.findUnique.mockResolvedValue(null);

      await expect(service.deactivate('NOPE')).rejects.toThrow(NotFoundException);
    });
  });
});
