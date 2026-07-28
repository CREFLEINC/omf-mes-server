import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, putaway_rule } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PutawayRuleQueryDto } from './putaway-rule.dto';
import { PutawayRuleService } from './putaway-rule.service';

const baseRule: putaway_rule = {
  putaway_rule_id: 1n,
  item_id: 10n,
  warehouse_id: 20n,
  location_id: null,
  capacity_qty: new Prisma.Decimal(1000),
  uom_id: 30n,
  priority_no: 100,
  is_active: true,
  remarks: null,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('PutawayRuleService', () => {
  let service: PutawayRuleService;
  let prisma: {
    putaway_rule: Record<string, jest.Mock>;
    item: Record<string, jest.Mock>;
    warehouse: Record<string, jest.Mock>;
    location: Record<string, jest.Mock>;
    uom: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      putaway_rule: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      item: { findUnique: jest.fn() },
      warehouse: { findMany: jest.fn() },
      location: { findUnique: jest.fn() },
      uom: { findUnique: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [PutawayRuleService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(PutawayRuleService);
  });

  const dto = {
    itemCode: 'ITEM_0001',
    warehouseCode: 'WH_MAT',
    capacityQty: 1000,
    uomCode: 'EA',
  };

  const givenRefs = () => {
    prisma.item.findUnique.mockResolvedValue({ item_id: 10n });
    prisma.warehouse.findMany.mockResolvedValue([{ warehouse_id: 20n, warehouse_code: 'WH_MAT' }]);
    prisma.uom.findUnique.mockResolvedValue({ uom_id: 30n });
  };

  describe('create', () => {
    it('로케이션을 생략하면 창고 단위 규칙이 된다', async () => {
      givenRefs();
      prisma.putaway_rule.findFirst.mockResolvedValue(null);
      prisma.putaway_rule.create.mockResolvedValue(baseRule);

      await service.create(dto);

      expect(prisma.putaway_rule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ location_id: null, priority_no: 100 }),
      });
    });

    it('품목×창고×로케이션이 겹치면 409', async () => {
      givenRefs();
      prisma.putaway_rule.findFirst.mockResolvedValue(baseRule);

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });

    // 창고코드는 (공장, 코드)로만 유일하다.
    it('창고코드가 여러 공장에 있으면 409', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 10n });
      prisma.uom.findUnique.mockResolvedValue({ uom_id: 30n });
      prisma.warehouse.findMany.mockResolvedValue([{ warehouse_id: 20n }, { warehouse_id: 21n }]);

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });

    // 다른 창고의 로케이션을 붙이면 적치가 엉뚱한 곳으로 간다.
    it('소속 창고에 없는 로케이션이면 404', async () => {
      givenRefs();
      prisma.location.findUnique.mockResolvedValue(null);

      await expect(service.create({ ...dto, locationCode: 'A-01-01' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('소속 창고의 로케이션이면 붙인다', async () => {
      givenRefs();
      prisma.location.findUnique.mockResolvedValue({ location_id: 40n });
      prisma.putaway_rule.findFirst.mockResolvedValue(null);
      prisma.putaway_rule.create.mockResolvedValue(baseRule);

      await service.create({ ...dto, locationCode: 'A-01-01' });

      expect(prisma.location.findUnique).toHaveBeenCalledWith({
        where: {
          warehouse_id_location_code: { warehouse_id: 20n, location_code: 'A-01-01' },
        },
      });
      expect(prisma.putaway_rule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ location_id: 40n }),
      });
    });
  });

  describe('findAll', () => {
    it('우선순위 순으로 정렬한다', async () => {
      prisma.putaway_rule.findMany.mockResolvedValue([]);
      prisma.putaway_rule.count.mockResolvedValue(0);

      const query = Object.assign(new PutawayRuleQueryDto(), { page: 1, size: 20 });
      await service.findAll(query);

      expect(prisma.putaway_rule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ priority_no: 'asc' }, { putaway_rule_id: 'asc' }],
        }),
      );
    });
  });

  describe('deactivate', () => {
    it('is_active=false로 내린다', async () => {
      prisma.putaway_rule.findUnique.mockResolvedValue(baseRule);
      prisma.putaway_rule.update.mockResolvedValue(baseRule);

      await service.deactivate(1n);

      expect(prisma.putaway_rule.update).toHaveBeenCalledWith({
        where: { putaway_rule_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});
