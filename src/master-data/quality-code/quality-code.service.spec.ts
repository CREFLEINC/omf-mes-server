import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { cause_code, defect_code } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CauseCodeService } from './cause-code.service';
import { DefectCodeService } from './defect-code.service';
import { QualityCodeQueryDto } from './quality-code.dto';

const rootDefect: defect_code = {
  defect_code_id: 1n,
  defect_code: 'APPEARANCE',
  defect_name: '외관',
  parent_defect_code_id: null,
  process_id: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const childDefect: defect_code = {
  ...rootDefect,
  defect_code_id: 2n,
  defect_code: 'SCRATCH',
  defect_name: '스크래치',
  parent_defect_code_id: 1n,
};

const rootCause: cause_code = {
  cause_code_id: 1n,
  cause_code: 'EQUIPMENT',
  cause_name: '설비',
  parent_cause_code_id: null,
  process_id: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const childCause: cause_code = {
  ...rootCause,
  cause_code_id: 2n,
  cause_code: 'MOLD_WEAR',
  cause_name: '금형 마모',
  parent_cause_code_id: 1n,
};

describe('DefectCodeService', () => {
  let service: DefectCodeService;
  let prisma: {
    defect_code: Record<string, jest.Mock>;
    defect_record: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      defect_code: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      defect_record: { count: jest.fn() },
      process: { findUnique: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [DefectCodeService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(DefectCodeService);
  });

  describe('create', () => {
    it('코드가 겹치면 409', async () => {
      prisma.defect_code.findUnique.mockResolvedValue(rootDefect);

      await expect(
        service.create({ defectCode: 'APPEARANCE', defectName: '외관' }),
      ).rejects.toThrow(ConflictException);
    });

    // 상위가 이미 하위면 손자 = 3계층이 된다.
    it('상위로 지정한 코드가 이미 하위면 400', async () => {
      prisma.defect_code.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(childDefect);

      await expect(
        service.create({ defectCode: 'DEEP', defectName: '깊은흠', parentDefectCode: 'SCRATCH' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('최상위를 상위로 주면 하위로 등록된다', async () => {
      prisma.defect_code.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(rootDefect);
      prisma.defect_code.create.mockResolvedValue(childDefect);

      await service.create({
        defectCode: 'SCRATCH',
        defectName: '스크래치',
        parentDefectCode: 'APPEARANCE',
      });

      expect(prisma.defect_code.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ parent_defect_code_id: 1n }),
      });
    });
  });

  describe('findAll', () => {
    it('isRootOnly면 상위가 없는 것만 본다', async () => {
      prisma.defect_code.findMany.mockResolvedValue([]);
      prisma.defect_code.count.mockResolvedValue(0);

      const query = Object.assign(new QualityCodeQueryDto(), {
        page: 1,
        size: 20,
        isRootOnly: true,
      });
      await service.findAll(query);

      expect(prisma.defect_code.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ parent_defect_code_id: null }),
        }),
      );
    });
  });

  describe('update', () => {
    it('하위가 달린 코드는 다른 코드 밑으로 옮길 수 없다', async () => {
      prisma.defect_code.findUnique
        .mockResolvedValueOnce(rootDefect)
        .mockResolvedValueOnce({ ...rootDefect, defect_code_id: 3n, defect_code: 'DIM' });
      prisma.defect_code.count.mockResolvedValue(2);

      await expect(
        service.update('APPEARANCE', { parentDefectCode: 'DIM' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('version_no를 증가시킨다', async () => {
      prisma.defect_code.findUnique.mockResolvedValue(rootDefect);
      prisma.defect_code.update.mockResolvedValue(rootDefect);

      await service.update('APPEARANCE', { defectName: '외관불량' });

      expect(prisma.defect_code.update).toHaveBeenCalledWith({
        where: { defect_code_id: 1n },
        data: expect.objectContaining({ version_no: { increment: 1 } }),
      });
    });
  });

  describe('deactivate', () => {
    it.each([
      ['사용중 하위코드', 1, 0],
      ['불량실적', 0, 1],
    ])('%s가 참조하면 409', async (_label, children, records) => {
      prisma.defect_code.findUnique.mockResolvedValue(rootDefect);
      prisma.defect_code.count.mockResolvedValue(children);
      prisma.defect_record.count.mockResolvedValue(records);

      await expect(service.deactivate('APPEARANCE')).rejects.toThrow(ConflictException);
      expect(prisma.defect_code.update).not.toHaveBeenCalled();
    });

    it('참조가 없으면 is_active=false', async () => {
      prisma.defect_code.findUnique.mockResolvedValue(rootDefect);
      prisma.defect_code.count.mockResolvedValue(0);
      prisma.defect_record.count.mockResolvedValue(0);
      prisma.defect_code.update.mockResolvedValue(rootDefect);

      await service.deactivate('APPEARANCE');

      expect(prisma.defect_code.update).toHaveBeenCalledWith({
        where: { defect_code_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});

describe('CauseCodeService', () => {
  let service: CauseCodeService;
  let prisma: {
    cause_code: Record<string, jest.Mock>;
    defect_record: Record<string, jest.Mock>;
    process: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      cause_code: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      defect_record: { count: jest.fn() },
      process: { findUnique: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [CauseCodeService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(CauseCodeService);
  });

  it('상위로 지정한 코드가 이미 하위면 400', async () => {
    prisma.cause_code.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(childCause);

    await expect(
      service.create({ causeCode: 'X', causeName: 'x', parentCauseCode: 'MOLD_WEAR' }),
    ).rejects.toThrow(BadRequestException);
  });

  // 불량실적은 추정원인·확정원인 두 자리에서 원인코드를 가리킨다.
  it.each([
    ['추정원인', 0, 1, 0],
    ['확정원인', 0, 0, 1],
  ])('%s가 참조하면 409', async (_label, children, suspected, confirmed) => {
    prisma.cause_code.findUnique.mockResolvedValue(rootCause);
    prisma.cause_code.count.mockResolvedValue(children);
    prisma.defect_record.count
      .mockResolvedValueOnce(suspected)
      .mockResolvedValueOnce(confirmed);

    await expect(service.deactivate('EQUIPMENT')).rejects.toThrow(ConflictException);
    expect(prisma.cause_code.update).not.toHaveBeenCalled();
  });
});
