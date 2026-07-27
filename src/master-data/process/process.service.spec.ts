import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { process as processModel } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { ProcessQueryDto } from './process.dto';
import { ProcessService } from './process.service';

const baseProcess: processModel = {
  process_id: 1n,
  process_code: 'MOLDING',
  process_name: '사출',
  process_type_code: 'INTERNAL',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('ProcessService', () => {
  let service: ProcessService;
  let prisma: {
    process: Record<string, jest.Mock>;
    routing_operation: Record<string, jest.Mock>;
    equipment: Record<string, jest.Mock>;
    worker_qualification: Record<string, jest.Mock>;
    terminal_process: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const codes = { assertValid: jest.fn(), assertAllValid: jest.fn() };

  /** 참조 카운트 4종을 한 번에 지정한다. */
  const setRefs = (routing = 0, equipment = 0, qualification = 0, terminal = 0) => {
    prisma.routing_operation.count.mockResolvedValue(routing);
    prisma.equipment.count.mockResolvedValue(equipment);
    prisma.worker_qualification.count.mockResolvedValue(qualification);
    prisma.terminal_process.count.mockResolvedValue(terminal);
  };

  beforeEach(async () => {
    codes.assertValid.mockResolvedValue(undefined);
    prisma = {
      process: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      routing_operation: { count: jest.fn() },
      equipment: { count: jest.fn() },
      worker_qualification: { count: jest.fn() },
      terminal_process: { count: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProcessService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(ProcessService);
  });

  describe('create', () => {
    it('공정 유형 코드값을 검증한다', async () => {
      prisma.process.findUnique.mockResolvedValue(null);
      prisma.process.create.mockResolvedValue(baseProcess);

      await service.create({
        processCode: 'MOLDING',
        processName: '사출',
        processTypeCode: 'INTERNAL',
      });

      expect(codes.assertValid).toHaveBeenCalledWith('PROCESS_TYPE', 'INTERNAL');
    });

    it('중복이면 409', async () => {
      prisma.process.findUnique.mockResolvedValue(baseProcess);

      await expect(
        service.create({ processCode: 'MOLDING', processName: 'x', processTypeCode: 'INTERNAL' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('유형 필터를 where에 넣는다', async () => {
      prisma.process.findMany.mockResolvedValue([]);
      prisma.process.count.mockResolvedValue(0);

      const query = Object.assign(new ProcessQueryDto(), {
        page: 1,
        size: 20,
        processTypeCode: 'OUTSOURCED',
      });
      await service.findAll(query);

      expect(prisma.process.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ process_type_code: 'OUTSOURCED' }),
        }),
      );
    });
  });

  describe('update', () => {
    it('없으면 404', async () => {
      prisma.process.findUnique.mockResolvedValue(null);

      await expect(service.update('NOPE', { processName: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('version_no를 증가시킨다', async () => {
      prisma.process.findUnique.mockResolvedValue(baseProcess);
      prisma.process.update.mockResolvedValue(baseProcess);

      await service.update('MOLDING', { processName: '사출(개정)' });

      expect(prisma.process.update).toHaveBeenCalledWith({
        where: { process_id: 1n },
        data: expect.objectContaining({ version_no: { increment: 1 } }),
      });
    });
  });

  describe('deactivate', () => {
    // routing_operation·worker_qualification·terminal_process에는 is_active가 없어
    // 존재 자체를 참조로 본다.
    it.each([
      ['라우팅 라인', 1, 0, 0, 0],
      ['설비', 0, 1, 0, 0],
      ['작업자 자격', 0, 0, 1, 0],
      ['단말 매핑', 0, 0, 0, 1],
    ])('%s가 참조하면 409', async (_label, r, e, q, t) => {
      prisma.process.findUnique.mockResolvedValue(baseProcess);
      setRefs(r, e, q, t);

      await expect(service.deactivate('MOLDING')).rejects.toThrow(ConflictException);
      expect(prisma.process.update).not.toHaveBeenCalled();
    });

    it('참조가 없으면 is_active=false', async () => {
      prisma.process.findUnique.mockResolvedValue(baseProcess);
      setRefs();
      prisma.process.update.mockResolvedValue(baseProcess);

      await service.deactivate('MOLDING');

      expect(prisma.process.update).toHaveBeenCalledWith({
        where: { process_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });

    it('설비는 사용중(is_active=true)인 것만 센다', async () => {
      prisma.process.findUnique.mockResolvedValue(baseProcess);
      setRefs();
      prisma.process.update.mockResolvedValue(baseProcess);

      await service.deactivate('MOLDING');

      expect(prisma.equipment.count).toHaveBeenCalledWith({
        where: { process_id: 1n, is_active: true },
      });
    });
  });
});
