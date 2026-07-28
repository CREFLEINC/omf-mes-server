import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { terminal } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { OrganizationService } from '../organization/organization.service';
import { WarehouseService } from '../warehouse/warehouse.service';
import { TerminalService } from './terminal.service';

const baseTerminal: terminal = {
  terminal_id: 1n,
  terminal_code: 'POP_INJ_01',
  plant_id: 1n,
  location_id: null,
  terminal_type_code: 'POP',
  status_code: 'NORMAL',
  is_active: true,
  token_version: 1,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('TerminalService', () => {
  let service: TerminalService;
  let prisma: {
    terminal: Record<string, jest.Mock>;
    terminal_process: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const org = { findPlant: jest.fn() };
  const warehouses = { findLocation: jest.fn() };
  const codes = { assertAllValid: jest.fn(), assertValid: jest.fn() };

  beforeEach(async () => {
    org.findPlant.mockResolvedValue({ plant_id: 1n });
    codes.assertAllValid.mockResolvedValue(undefined);
    prisma = {
      terminal: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      terminal_process: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
      process: { findUnique: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TerminalService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrganizationService, useValue: org },
        { provide: WarehouseService, useValue: warehouses },
        { provide: CodeValidatorService, useValue: codes },
      ],
    }).compile();

    service = moduleRef.get(TerminalService);
  });

  const newTerminal = {
    legalEntityCode: 'OMF_VN',
    plantCode: 'PLANT1',
    terminalCode: 'POP_INJ_01',
    terminalTypeCode: 'POP',
    statusCode: 'NORMAL',
  };

  describe('설치 위치', () => {
    it('창고·로케이션을 함께 주면 위치를 붙인다', async () => {
      prisma.terminal.findUnique.mockResolvedValue(null);
      prisma.terminal.create.mockResolvedValue(baseTerminal);
      warehouses.findLocation.mockResolvedValue({ location_id: 9n });

      await service.create({ ...newTerminal, warehouseCode: 'WH_MAT', locationCode: 'A-01' });

      expect(prisma.terminal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ location_id: 9n }),
      });
    });

    // 로케이션 코드는 창고 범위 유니크라 창고 없이는 특정되지 않는다.
    it('한쪽만 주면 400', async () => {
      prisma.terminal.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ ...newTerminal, warehouseCode: 'WH_MAT' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({ ...newTerminal, locationCode: 'A-01' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('둘 다 없으면 위치 없이 등록된다', async () => {
      prisma.terminal.findUnique.mockResolvedValue(null);
      prisma.terminal.create.mockResolvedValue(baseTerminal);

      await service.create(newTerminal);

      expect(prisma.terminal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ location_id: null }),
      });
    });
  });

  describe('공정별 기능 매핑', () => {
    beforeEach(() => {
      prisma.terminal.findUnique.mockResolvedValue(baseTerminal);
      prisma.process.findUnique.mockResolvedValue({ process_id: 5n });
      prisma.terminal_process.upsert.mockResolvedValue({});
    });

    it('지정하지 않은 기능은 false로 저장한다 — 재저장 시 이전 값이 남지 않는다', async () => {
      await service.upsertProcess('POP_INJ_01', {
        processCode: 'MOLDING',
        canPrintLabel: true,
      });

      const arg = prisma.terminal_process.upsert.mock.calls[0][0];
      expect(arg.update).toEqual(
        expect.objectContaining({ can_print_label: true, can_start_work: false }),
      );
      // upsert의 update와 create가 같은 플래그 집합을 써야 덮어쓰기 의미가 성립한다.
      expect(arg.create).toEqual(expect.objectContaining(arg.update));
    });

    it('없는 공정이면 404', async () => {
      prisma.process.findUnique.mockResolvedValue(null);

      await expect(
        service.upsertProcess('POP_INJ_01', { processCode: 'ZZZ' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('없는 매핑을 해제하면 404', async () => {
      prisma.terminal_process.findUnique.mockResolvedValue(null);

      await expect(service.removeProcess('POP_INJ_01', 'MOLDING')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
