import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from './code-validator.service';

describe('CodeValidatorService', () => {
  let service: CodeValidatorService;
  let prisma: { code_value: Record<string, jest.Mock> };

  beforeEach(async () => {
    prisma = { code_value: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };

    const moduleRef = await Test.createTestingModule({
      providers: [CodeValidatorService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(CodeValidatorService);
  });

  it('그룹에 있는 코드면 통과한다', async () => {
    prisma.code_value.findFirst.mockResolvedValue({ code_value_id: 1n });

    await expect(service.assertValid('WAREHOUSE_TYPE', 'MATERIAL')).resolves.toBeUndefined();
  });

  it('그룹에 없는 코드면 400', async () => {
    prisma.code_value.findFirst.mockResolvedValue(null);

    await expect(service.assertValid('WAREHOUSE_TYPE', 'NOPE')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('선택 컬럼은 값이 없으면 검사하지 않는다', async () => {
    await expect(service.assertValid('QUALITY_ZONE', undefined)).resolves.toBeUndefined();
    await expect(service.assertValid('QUALITY_ZONE', null)).resolves.toBeUndefined();
    expect(prisma.code_value.findFirst).not.toHaveBeenCalled();
  });

  it('비활성 코드는 통과시키지 않는다 — is_active 조건을 건다', async () => {
    prisma.code_value.findFirst.mockResolvedValue(null);

    await expect(service.assertValid('LOCATION_TYPE', 'OLD')).rejects.toThrow(BadRequestException);
    expect(prisma.code_value.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ is_active: true }),
      }),
    );
  });

  it('오류 메시지에 사용 가능한 코드를 담아 준다', async () => {
    prisma.code_value.findFirst.mockResolvedValue(null);
    prisma.code_value.findMany.mockResolvedValue([{ code: 'ZONE' }, { code: 'CELL' }]);

    await expect(service.assertValid('LOCATION_TYPE', 'X')).rejects.toThrow(/ZONE, CELL/);
  });
});
