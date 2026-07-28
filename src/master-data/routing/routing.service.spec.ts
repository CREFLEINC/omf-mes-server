import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { routing, routing_operation } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { RoutingQueryDto } from './routing.dto';
import { RoutingService } from './routing.service';

const baseRouting: routing = {
  routing_id: 1n,
  item_id: 10n,
  routing_code: 'RT_COVER',
  routing_version: 1,
  status_code: 'DRAFT',
  effective_from: new Date('2026-01-01'),
  effective_to: null,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const operation = (id: bigint, seq: number): routing_operation => ({
  routing_operation_id: id,
  routing_id: 1n,
  operation_seq: seq,
  process_id: 100n,
  operation_name: `공정 ${seq}`,
  mes_managed: true,
  material_input_managed: false,
  production_result_managed: true,
  inspection_managed: false,
  output_lot_required: false,
  equipment_required: false,
  mold_required: false,
  standard_cycle_time_sec: null,
  standard_yield_rate: null,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
});

describe('RoutingService', () => {
  let service: RoutingService;
  let prisma: {
    routing: Record<string, jest.Mock>;
    routing_operation: Record<string, jest.Mock>;
    routing_operation_dependency: Record<string, jest.Mock>;
    item: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    production_plan: Record<string, jest.Mock>;
    work_order: Record<string, jest.Mock>;
    bom_component: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      routing: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      routing_operation: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      routing_operation_dependency: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      item: { findUnique: jest.fn() },
      process: { findUnique: jest.fn() },
      production_plan: { count: jest.fn() },
      work_order: { count: jest.fn() },
      bom_component: { count: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RoutingService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(RoutingService);
  });

  const createDto = {
    itemCode: 'ITEM_0001',
    routingCode: 'RT_COVER',
    routingVersion: 1,
    statusCode: 'DRAFT',
    effectiveFrom: new Date('2026-01-01'),
  };

  describe('create', () => {
    it('개정 상태 코드값을 검증한다', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 10n });
      prisma.routing.findUnique.mockResolvedValue(null);
      prisma.routing.create.mockResolvedValue(baseRouting);

      await service.create(createDto);

      expect(codes.assertValid).toHaveBeenCalledWith('REVISION_STATUS', 'DRAFT');
    });

    it('품목이 없으면 404', async () => {
      prisma.item.findUnique.mockResolvedValue(null);

      await expect(service.create(createDto)).rejects.toThrow(NotFoundException);
    });

    it('품목×코드×Rev가 겹치면 409', async () => {
      prisma.item.findUnique.mockResolvedValue({ item_id: 10n });
      prisma.routing.findUnique.mockResolvedValue(baseRouting);

      await expect(service.create(createDto)).rejects.toThrow(ConflictException);
    });

    it('유효 종료일이 시작일보다 빠르면 400', async () => {
      await expect(
        service.create({ ...createDto, effectiveTo: new Date('2025-12-31') }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('품목·상태 필터를 where에 넣는다', async () => {
      prisma.routing.findMany.mockResolvedValue([]);
      prisma.routing.count.mockResolvedValue(0);

      const query = Object.assign(new RoutingQueryDto(), {
        page: 1,
        size: 20,
        itemCode: 'ITEM_0001',
        statusCode: 'ACTIVE',
      });
      await service.findAll(query);

      expect(prisma.routing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            item: { item_code: 'ITEM_0001' },
            status_code: 'ACTIVE',
          }),
        }),
      );
    });
  });

  describe('update', () => {
    it('version_no를 증가시킨다', async () => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.routing.update.mockResolvedValue(baseRouting);

      await service.update(1n, { statusCode: 'ACTIVE' });

      expect(prisma.routing.update).toHaveBeenCalledWith({
        where: { routing_id: 1n },
        data: expect.objectContaining({ version_no: { increment: 1 } }),
      });
    });

    it('기존 시작일과 새 종료일의 역전도 잡는다', async () => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);

      await expect(service.update(1n, { effectiveTo: new Date('2025-06-01') })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('obsolete', () => {
    it.each([
      ['생산계획', 1, 0],
      ['작업지시', 0, 1],
    ])('%s가 참조하면 409', async (_label, plans, workOrders) => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.production_plan.count.mockResolvedValue(plans);
      prisma.work_order.count.mockResolvedValue(workOrders);

      await expect(service.obsolete(1n)).rejects.toThrow(ConflictException);
      expect(prisma.routing.update).not.toHaveBeenCalled();
    });

    it('참조가 없으면 OBSOLETE로 내린다', async () => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.production_plan.count.mockResolvedValue(0);
      prisma.work_order.count.mockResolvedValue(0);
      prisma.routing.update.mockResolvedValue(baseRouting);

      await service.obsolete(1n);

      expect(prisma.routing.update).toHaveBeenCalledWith({
        where: { routing_id: 1n },
        data: expect.objectContaining({ status_code: 'OBSOLETE' }),
      });
    });
  });

  describe('addOperation', () => {
    const dto = { operationSeq: 10, processCode: 'MOLDING', operationName: '사출' };

    it('공정 순서가 겹치면 409', async () => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.process.findUnique.mockResolvedValue({ process_id: 100n });
      prisma.routing_operation.findUnique.mockResolvedValue(operation(1n, 10));

      await expect(service.addOperation(1n, dto)).rejects.toThrow(ConflictException);
    });

    it('공정이 없으면 404', async () => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.process.findUnique.mockResolvedValue(null);

      await expect(service.addOperation(1n, dto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeOperation', () => {
    it.each([
      ['작업지시', 1, 0, 0],
      ['BOM 라인', 0, 1, 0],
      ['선후행', 0, 0, 1],
    ])('%s가 참조하면 409', async (_label, wo, bom, dep) => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.routing_operation.findUnique.mockResolvedValue(operation(1n, 10));
      prisma.work_order.count.mockResolvedValue(wo);
      prisma.bom_component.count.mockResolvedValue(bom);
      prisma.routing_operation_dependency.count.mockResolvedValue(dep);

      await expect(service.removeOperation(1n, 10)).rejects.toThrow(ConflictException);
      expect(prisma.routing_operation.delete).not.toHaveBeenCalled();
    });
  });

  describe('addDependency', () => {
    /** 순서 10·20·30이 각각 id 1·2·3인 라우팅. */
    const givenThreeOperations = () => {
      prisma.routing.findUnique.mockResolvedValue(baseRouting);
      prisma.routing_operation.findUnique.mockImplementation(
        ({ where }: { where: { routing_id_operation_seq: { operation_seq: number } } }) => {
          const seq = where.routing_id_operation_seq.operation_seq;
          const ids: Record<number, bigint> = { 10: 1n, 20: 2n, 30: 3n };
          return Promise.resolve(ids[seq] ? operation(ids[seq], seq) : null);
        },
      );
      prisma.routing_operation.findMany.mockResolvedValue([
        { routing_operation_id: 1n },
        { routing_operation_id: 2n },
        { routing_operation_id: 3n },
      ]);
    };

    it('선행과 후행이 같으면 400', async () => {
      await expect(
        service.addDependency(1n, { predecessorSeq: 10, successorSeq: 10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('이미 등록된 선후행이면 409', async () => {
      givenThreeOperations();
      prisma.routing_operation_dependency.findUnique.mockResolvedValue({
        routing_operation_dependency_id: 1n,
      });

      await expect(
        service.addDependency(1n, { predecessorSeq: 10, successorSeq: 20 }),
      ).rejects.toThrow(ConflictException);
    });

    // 10→20→30이 있는 상태에서 30→10을 더하면 순환이 된다.
    it('순환이 생기면 400', async () => {
      givenThreeOperations();
      prisma.routing_operation_dependency.findUnique.mockResolvedValue(null);
      prisma.routing_operation_dependency.findMany.mockResolvedValue([
        { predecessor_operation_id: 1n, successor_operation_id: 2n },
        { predecessor_operation_id: 2n, successor_operation_id: 3n },
      ]);

      await expect(
        service.addDependency(1n, { predecessorSeq: 30, successorSeq: 10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('순환이 아니면 등록한다', async () => {
      givenThreeOperations();
      prisma.routing_operation_dependency.findUnique.mockResolvedValue(null);
      prisma.routing_operation_dependency.findMany.mockResolvedValue([
        { predecessor_operation_id: 1n, successor_operation_id: 2n },
      ]);
      prisma.routing_operation_dependency.create.mockResolvedValue({
        routing_operation_dependency_id: 9n,
      });

      await service.addDependency(1n, { predecessorSeq: 20, successorSeq: 30 });

      expect(prisma.routing_operation_dependency.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          predecessor_operation_id: 2n,
          successor_operation_id: 3n,
          dependency_type_code: 'FINISH_TO_START',
        }),
      });
    });
  });
});
