import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { item } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { ItemService } from './item.service';

const baseItem: item = {
  item_id: 1n,
  item_code: 'ITEM_0001',
  item_name: '사출 커버',
  item_type_code: 'RAW',
  base_uom_id: 1n,
  lot_control_type_code: 'LOT',
  serial_control_type_code: 'NONE',
  shelf_life_days: null,
  inspection_required: false,
  fifo_policy_code: 'FIFO',
  negative_stock_allowed: false,
  storage_condition_code: null,
  opened_shelf_life_hours: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('ItemService', () => {
  let service: ItemService;
  let prisma: {
    item: Record<string, jest.Mock>;
    uom: Record<string, jest.Mock>;
    inventory_balance: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertAllValid: jest.fn(), assertValid: jest.fn() };

  beforeEach(async () => {
    codes.assertAllValid.mockResolvedValue(undefined);
    prisma = {
      item: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      uom: { findUnique: jest.fn().mockResolvedValue({ uom_id: 1n, uom_code: 'EA' }) },
      inventory_balance: { count: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ItemService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(ItemService);
  });

  const newItem = {
    itemCode: 'ITEM_0001',
    itemName: '사출 커버',
    itemTypeCode: 'RAW',
    baseUomCode: 'EA',
    lotControlTypeCode: 'LOT',
  };

  describe('create', () => {
    it('기본값(NONE·FIFO)을 채워 등록한다', async () => {
      prisma.item.findUnique.mockResolvedValue(null);
      prisma.item.create.mockResolvedValue(baseItem);

      await service.create(newItem);

      expect(prisma.item.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          serial_control_type_code: 'NONE',
          fifo_policy_code: 'FIFO',
          base_uom_id: 1n,
        }),
      });
    });

    it('코드값을 모두 검증한다', async () => {
      prisma.item.findUnique.mockResolvedValue(null);
      prisma.item.create.mockResolvedValue(baseItem);

      await service.create(newItem);

      expect(codes.assertAllValid).toHaveBeenCalledWith(
        expect.arrayContaining([
          ['ITEM_TYPE', 'RAW'],
          ['LOT_CONTROL_TYPE', 'LOT'],
        ]),
      );
    });

    it('없는 기본단위면 404', async () => {
      prisma.uom.findUnique.mockResolvedValue(null);

      await expect(service.create({ ...newItem, baseUomCode: 'ZZZ' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('중복 품목코드면 409', async () => {
      prisma.item.findUnique.mockResolvedValue(baseItem);

      await expect(service.create(newItem)).rejects.toThrow(ConflictException);
    });
  });

  // QA #28 — 유효기한 관리 품목=FEFO, 나머지=FIFO. DDL에 없어 앱에서만 막는다.
  describe('FEFO 정합성', () => {
    it('FEFO인데 유효기간이 없으면 400', async () => {
      prisma.item.findUnique.mockResolvedValue(null);

      await expect(service.create({ ...newItem, fifoPolicyCode: 'FEFO' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.item.create).not.toHaveBeenCalled();
    });

    it('FEFO + 유효기간이면 통과한다', async () => {
      prisma.item.findUnique.mockResolvedValue(null);
      prisma.item.create.mockResolvedValue(baseItem);

      await service.create({ ...newItem, fifoPolicyCode: 'FEFO', shelfLifeDays: 365 });

      expect(prisma.item.create).toHaveBeenCalled();
    });

    it('수정으로 FEFO만 켜도 막는다 — 저장될 최종 상태로 검사', async () => {
      prisma.item.findUnique.mockResolvedValue(baseItem); // shelf_life_days = null

      await expect(service.update('ITEM_0001', { fifoPolicyCode: 'FEFO' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('기존에 유효기간이 있으면 FEFO 전환을 허용한다', async () => {
      prisma.item.findUnique.mockResolvedValue({ ...baseItem, shelf_life_days: 180 });
      prisma.item.update.mockResolvedValue(baseItem);

      await service.update('ITEM_0001', { fifoPolicyCode: 'FEFO' });

      expect(prisma.item.update).toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('잔량 재고가 있으면 409', async () => {
      prisma.item.findUnique.mockResolvedValue(baseItem);
      prisma.inventory_balance.count.mockResolvedValue(2);

      await expect(service.deactivate('ITEM_0001')).rejects.toThrow(ConflictException);
      expect(prisma.item.update).not.toHaveBeenCalled();
    });

    it('재고가 없으면 is_active=false', async () => {
      prisma.item.findUnique.mockResolvedValue(baseItem);
      prisma.inventory_balance.count.mockResolvedValue(0);
      prisma.item.update.mockResolvedValue(baseItem);

      await service.deactivate('ITEM_0001');

      expect(prisma.item.update).toHaveBeenCalledWith({
        where: { item_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});
