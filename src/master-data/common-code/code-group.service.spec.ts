import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { code_group } from '@prisma/client';

import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeGroupService } from './code-group.service';

const baseGroup: code_group = {
  code_group_id: 1n,
  group_code: 'ITEM_TYPE',
  group_name: '품목구분',
  description: null,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('CodeGroupService', () => {
  let service: CodeGroupService;
  let prisma: {
    code_group: Record<string, jest.Mock>;
    code_value: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      code_group: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      code_value: { count: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [CodeGroupService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(CodeGroupService);
  });

  describe('create', () => {
    it('신규 코드그룹을 등록한다', async () => {
      prisma.code_group.findUnique.mockResolvedValue(null);
      prisma.code_group.create.mockResolvedValue(baseGroup);

      await service.create({ groupCode: 'ITEM_TYPE', groupName: '품목구분' });

      expect(prisma.code_group.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          group_code: 'ITEM_TYPE',
          group_name: '품목구분',
          is_active: true,
        }),
      });
    });

    it('이미 있으면 409', async () => {
      prisma.code_group.findUnique.mockResolvedValue(baseGroup);

      await expect(
        service.create({ groupCode: 'ITEM_TYPE', groupName: 'x' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('isActive=false를 필터로 그대로 전달한다', async () => {
      prisma.code_group.findMany.mockResolvedValue([]);
      prisma.code_group.count.mockResolvedValue(0);

      const query = Object.assign(new PageQueryDto(), { page: 1, size: 20, isActive: false });
      const result = await service.findAll(query);

      expect(prisma.code_group.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { is_active: false } }),
      );
      expect(result.total).toBe(0);
    });

    it('키워드는 코드·명칭 양쪽을 본다', async () => {
      prisma.code_group.findMany.mockResolvedValue([]);
      prisma.code_group.count.mockResolvedValue(0);

      const query = Object.assign(new PageQueryDto(), { page: 1, size: 20, keyword: '품목' });
      await service.findAll(query);

      expect(prisma.code_group.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.arrayContaining([expect.any(Object)]) }),
        }),
      );
    });
  });

  describe('update', () => {
    it('없으면 404', async () => {
      prisma.code_group.findUnique.mockResolvedValue(null);

      await expect(service.update('NOPE', { groupName: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('낙관적 락 컬럼(version_no)을 증가시킨다', async () => {
      prisma.code_group.findUnique.mockResolvedValue(baseGroup);
      prisma.code_group.update.mockResolvedValue(baseGroup);

      await service.update('ITEM_TYPE', { groupName: '품목구분(수정)' });

      expect(prisma.code_group.update).toHaveBeenCalledWith({
        where: { code_group_id: 1n },
        data: expect.objectContaining({
          group_name: '품목구분(수정)',
          version_no: { increment: 1 },
        }),
      });
    });
  });

  describe('deactivate', () => {
    it('사용중인 하위 코드값이 있으면 409', async () => {
      prisma.code_group.findUnique.mockResolvedValue(baseGroup);
      prisma.code_value.count.mockResolvedValue(3);

      await expect(service.deactivate('ITEM_TYPE')).rejects.toThrow(ConflictException);
      expect(prisma.code_group.update).not.toHaveBeenCalled();
    });

    it('하위 코드값이 없으면 is_active=false로 만든다 (물리 삭제 아님)', async () => {
      prisma.code_group.findUnique.mockResolvedValue(baseGroup);
      prisma.code_value.count.mockResolvedValue(0);
      prisma.code_group.update.mockResolvedValue(baseGroup);

      await service.deactivate('ITEM_TYPE');

      expect(prisma.code_group.update).toHaveBeenCalledWith({
        where: { code_group_id: 1n },
        data: expect.objectContaining({ is_active: false }),
      });
    });
  });
});
