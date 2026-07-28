import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { bom, bom_component, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { BomQueryDto } from './bom.dto';
import { BomService } from './bom.service';

const PARENT_ITEM_ID = 10n;

const baseBom: bom = {
  bom_id: 1n,
  parent_item_id: PARENT_ITEM_ID,
  bom_code: 'BOM_COVER',
  bom_version: 1,
  status_code: 'DRAFT',
  is_default: false,
  effective_from: new Date('2026-01-01'),
  effective_to: null,
  base_qty: new Prisma.Decimal(1),
  base_uom_id: 50n,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const baseComponent: bom_component = {
  bom_component_id: 100n,
  bom_id: 1n,
  component_item_id: 20n,
  routing_operation_id: null,
  actual_use_process_id: null,
  required_qty: new Prisma.Decimal(2),
  uom_id: 50n,
  scrap_rate: new Prisma.Decimal(0),
  is_mandatory: true,
  lot_trace_required: false,
  backflush_allowed: false,
  sequence_no: 10,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('BomService', () => {
  let service: BomService;
  let prisma: {
    bom: Record<string, jest.Mock>;
    bom_component: Record<string, jest.Mock>;
    material_substitution_rule: Record<string, jest.Mock>;
    material_issue_request_line: Record<string, jest.Mock>;
    material_consumption: Record<string, jest.Mock>;
    routing_operation: Record<string, jest.Mock>;
    production_plan: Record<string, jest.Mock>;
    item: Record<string, jest.Mock>;
    uom: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    partner: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      bom: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      bom_component: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      material_substitution_rule: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      material_issue_request_line: { count: jest.fn() },
      material_consumption: { count: jest.fn() },
      routing_operation: { findUnique: jest.fn() },
      production_plan: { count: jest.fn() },
      item: { findUnique: jest.fn() },
      uom: { findUnique: jest.fn() },
      process: { findUnique: jest.fn() },
      partner: { findUnique: jest.fn() },
      // 서비스가 배열형(읽기 병렬)과 콜백형(기본 BOM 전환) 둘 다 쓴다.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BomService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(BomService);
  });

  const createDto = {
    parentItemCode: 'ITEM_0001',
    bomCode: 'BOM_COVER',
    bomVersion: 1,
    statusCode: 'DRAFT',
    baseQty: 1,
    baseUomCode: 'EA',
    effectiveFrom: new Date('2026-01-01'),
  };

  describe('create', () => {
    beforeEach(() => {
      prisma.item.findUnique.mockResolvedValue({ item_id: PARENT_ITEM_ID });
      prisma.uom.findUnique.mockResolvedValue({ uom_id: 50n });
    });

    it('개정 상태 코드값을 검증한다', async () => {
      prisma.bom.findUnique.mockResolvedValue(null);
      prisma.bom.create.mockResolvedValue(baseBom);

      await service.create(createDto);

      expect(codes.assertValid).toHaveBeenCalledWith('REVISION_STATUS', 'DRAFT');
    });

    it('부모품목×코드×Rev가 겹치면 409', async () => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);

      await expect(service.create(createDto)).rejects.toThrow(ConflictException);
    });

    it('유효 종료일이 시작일보다 빠르면 400', async () => {
      await expect(
        service.create({ ...createDto, effectiveTo: new Date('2025-12-31') }),
      ).rejects.toThrow(BadRequestException);
    });

    it('기본 BOM으로 만들면 같은 품목의 기존 기본 BOM을 내린다', async () => {
      prisma.bom.findUnique.mockResolvedValue(null);
      prisma.bom.create.mockResolvedValue(baseBom);

      await service.create({ ...createDto, isDefault: true });

      expect(prisma.bom.updateMany).toHaveBeenCalledWith({
        where: { parent_item_id: PARENT_ITEM_ID, is_default: true },
        data: expect.objectContaining({ is_default: false }),
      });
    });

    it('기본 BOM이 아니면 기존 지정을 건드리지 않는다', async () => {
      prisma.bom.findUnique.mockResolvedValue(null);
      prisma.bom.create.mockResolvedValue(baseBom);

      await service.create(createDto);

      expect(prisma.bom.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('부모품목·상태·기본여부 필터를 where에 넣는다', async () => {
      prisma.bom.findMany.mockResolvedValue([]);
      prisma.bom.count.mockResolvedValue(0);

      const query = Object.assign(new BomQueryDto(), {
        page: 1,
        size: 20,
        parentItemCode: 'ITEM_0001',
        statusCode: 'ACTIVE',
        isDefault: true,
      });
      await service.findAll(query);

      expect(prisma.bom.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            item: { item_code: 'ITEM_0001' },
            status_code: 'ACTIVE',
            is_default: true,
          }),
        }),
      );
    });
  });

  describe('update', () => {
    it('기본 BOM으로 올릴 때 자기 자신은 해제 대상에서 뺀다', async () => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.bom.update.mockResolvedValue(baseBom);

      await service.update(1n, { isDefault: true });

      expect(prisma.bom.updateMany).toHaveBeenCalledWith({
        where: {
          parent_item_id: PARENT_ITEM_ID,
          is_default: true,
          bom_id: { not: 1n },
        },
        data: expect.objectContaining({ is_default: false }),
      });
    });

    it('version_no를 증가시킨다', async () => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.bom.update.mockResolvedValue(baseBom);

      await service.update(1n, { statusCode: 'ACTIVE' });

      expect(prisma.bom.update).toHaveBeenCalledWith({
        where: { bom_id: 1n },
        data: expect.objectContaining({ version_no: { increment: 1 } }),
      });
    });
  });

  describe('obsolete', () => {
    it('생산계획이 참조하면 409', async () => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.production_plan.count.mockResolvedValue(1);

      await expect(service.obsolete(1n)).rejects.toThrow(ConflictException);
      expect(prisma.bom.update).not.toHaveBeenCalled();
    });

    it('폐기하면 기본 BOM 지정도 함께 내린다', async () => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.production_plan.count.mockResolvedValue(0);
      prisma.bom.update.mockResolvedValue(baseBom);

      await service.obsolete(1n);

      expect(prisma.bom.update).toHaveBeenCalledWith({
        where: { bom_id: 1n },
        data: expect.objectContaining({ status_code: 'OBSOLETE', is_default: false }),
      });
    });
  });

  describe('addComponent', () => {
    const dto = {
      sequenceNo: 10,
      componentItemCode: 'ITEM_9001',
      requiredQty: 2,
      uomCode: 'EA',
    };

    beforeEach(() => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.uom.findUnique.mockResolvedValue({ uom_id: 50n });
    });

    it('구성 품목이 부모 품목과 같으면 400', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: PARENT_ITEM_ID });

      await expect(service.addComponent(1n, dto)).rejects.toThrow(BadRequestException);
    });

    it('라인 순서가 겹치면 409', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 20n });
      prisma.bom_component.findUnique.mockResolvedValue(baseComponent);

      await expect(service.addComponent(1n, dto)).rejects.toThrow(ConflictException);
    });

    it('다른 품목의 라우팅 공정을 지정하면 400', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 20n });
      prisma.routing_operation.findUnique.mockResolvedValue({
        routing_operation_id: 7n,
        routing: { item_id: 999n },
      });

      await expect(
        service.addComponent(1n, { ...dto, routingOperationId: 7 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('부모 품목의 라우팅 공정이면 붙인다', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 20n });
      prisma.routing_operation.findUnique.mockResolvedValue({
        routing_operation_id: 7n,
        routing: { item_id: PARENT_ITEM_ID },
      });
      prisma.bom_component.findUnique.mockResolvedValue(null);
      prisma.bom_component.create.mockResolvedValue(baseComponent);

      await service.addComponent(1n, { ...dto, routingOperationId: 7 });

      expect(prisma.bom_component.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ routing_operation_id: 7n }),
      });
    });
  });

  describe('removeComponent', () => {
    it.each([
      ['불출요청', 1, 0, 0],
      ['자재소비', 0, 1, 0],
      ['대체규칙', 0, 0, 1],
    ])('%s가 참조하면 409', async (_label, issue, consumption, substitution) => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.bom_component.findUnique.mockResolvedValue(baseComponent);
      prisma.material_issue_request_line.count.mockResolvedValue(issue);
      prisma.material_consumption.count.mockResolvedValue(consumption);
      prisma.material_substitution_rule.count.mockResolvedValue(substitution);

      await expect(service.removeComponent(1n, 10)).rejects.toThrow(ConflictException);
      expect(prisma.bom_component.delete).not.toHaveBeenCalled();
    });
  });

  describe('addSubstitutionRule', () => {
    const dto = {
      substituteItemCode: 'ITEM_9002',
      effectiveFrom: new Date('2026-01-01'),
    };

    beforeEach(() => {
      prisma.bom.findUnique.mockResolvedValue(baseBom);
      prisma.bom_component.findUnique.mockResolvedValue(baseComponent);
    });

    it('대체 품목이 원래 구성 품목과 같으면 400', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: baseComponent.component_item_id });

      await expect(service.addSubstitutionRule(1n, 10, dto)).rejects.toThrow(BadRequestException);
    });

    it('같은 시작일의 규칙이 있으면 409', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 30n });
      prisma.material_substitution_rule.findUnique.mockResolvedValue({ substitution_rule_id: 1n });

      await expect(service.addSubstitutionRule(1n, 10, dto)).rejects.toThrow(ConflictException);
    });

    it('기본 우선순위는 1, 승인필요는 true다', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 30n });
      prisma.material_substitution_rule.findUnique.mockResolvedValue(null);
      prisma.material_substitution_rule.create.mockResolvedValue({ substitution_rule_id: 1n });

      await service.addSubstitutionRule(1n, 10, dto);

      expect(prisma.material_substitution_rule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ priority_no: 1, approval_required: true }),
      });
    });
  });
});
