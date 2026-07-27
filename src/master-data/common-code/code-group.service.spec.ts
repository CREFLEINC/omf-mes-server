import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CodeGroup, DataSource } from '@prisma/client';

import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeGroupService } from './code-group.service';

const baseGroup: CodeGroup = {
  code: 'ITEM_TYPE',
  nameKo: '품목구분',
  nameVi: null,
  description: null,
  sortOrder: 10,
  useYn: true,
  source: DataSource.MES,
  createdAt: new Date(),
  createdBy: null,
  updatedAt: new Date(),
  updatedBy: null,
  deletedAt: null,
};

describe('CodeGroupService', () => {
  let service: CodeGroupService;
  let prisma: {
    codeGroup: Record<string, jest.Mock>;
    codeValue: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      codeGroup: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      codeValue: { count: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [CodeGroupService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(CodeGroupService);
  });

  describe('create', () => {
    it('신규 코드그룹을 등록한다', async () => {
      prisma.codeGroup.findUnique.mockResolvedValue(null);
      prisma.codeGroup.create.mockResolvedValue(baseGroup);

      await service.create({ code: 'ITEM_TYPE', nameKo: '품목구분' });

      expect(prisma.codeGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'ITEM_TYPE', sortOrder: 0, useYn: true }),
        }),
      );
    });

    it('사용중인 코드가 있으면 409', async () => {
      prisma.codeGroup.findUnique.mockResolvedValue(baseGroup);

      await expect(service.create({ code: 'ITEM_TYPE', nameKo: 'x' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('소프트 삭제된 코드는 되살리되, 미지정 필드는 기본값으로 되돌린다', async () => {
      prisma.codeGroup.findUnique.mockResolvedValue({
        ...baseGroup,
        nameVi: '삭제 전 값',
        sortOrder: 99,
        deletedAt: new Date(),
      });
      prisma.codeGroup.update.mockResolvedValue(baseGroup);

      await service.create({ code: 'ITEM_TYPE', nameKo: '재등록' });

      expect(prisma.codeGroup.update).toHaveBeenCalledWith({
        where: { code: 'ITEM_TYPE' },
        data: expect.objectContaining({
          nameKo: '재등록',
          nameVi: null,
          sortOrder: 0,
          deletedAt: null,
        }),
      });
    });
  });

  describe('findAll', () => {
    it('useYn=false를 필터로 그대로 전달한다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([]);
      prisma.codeGroup.count.mockResolvedValue(0);

      const query = Object.assign(new PageQueryDto(), { page: 1, size: 20, useYn: false });
      const result = await service.findAll(query);

      expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, useYn: false } }),
      );
      expect(result.total).toBe(0);
    });

    it('includeDeleted=true면 deletedAt 조건을 걸지 않는다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([]);
      prisma.codeGroup.count.mockResolvedValue(0);

      const query = Object.assign(new PageQueryDto(), { page: 1, size: 20, includeDeleted: true });
      await service.findAll(query);

      expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('update', () => {
    it('없는 코드그룹이면 404', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(null);

      await expect(service.update('NOPE', { nameKo: 'x' })).rejects.toThrow(NotFoundException);
    });

    // ERP 연계분 규칙은 레코드 단위가 아니라 필드 단위다.
    // 근거: 2026-07-08-ERP-MES-수신정보-정리.md §4 — 원본 필드 읽기 전용 + MES 확장 속성 편집 가능
    describe('ERP 연계 수신본', () => {
      beforeEach(() => {
        prisma.codeGroup.findFirst.mockResolvedValue({ ...baseGroup, source: DataSource.ERP });
      });

      it('원본 필드(코드명 ko)를 고치려 하면 409', async () => {
        await expect(service.update('ITEM_TYPE', { nameKo: '수정시도' })).rejects.toThrow(
          ConflictException,
        );
        expect(prisma.codeGroup.update).not.toHaveBeenCalled();
      });

      it('원본 필드(정렬순서·사용여부)를 고치려 하면 409', async () => {
        await expect(service.update('ITEM_TYPE', { sortOrder: 5 })).rejects.toThrow(
          ConflictException,
        );
        await expect(service.update('ITEM_TYPE', { useYn: false })).rejects.toThrow(
          ConflictException,
        );
      });

      it('MES 확장 속성(베트남어 명칭)은 편집할 수 있다', async () => {
        prisma.codeGroup.update.mockResolvedValue(baseGroup);

        await service.update('ITEM_TYPE', { nameVi: 'Phân loại hàng hóa' });

        expect(prisma.codeGroup.update).toHaveBeenCalledWith({
          where: { code: 'ITEM_TYPE' },
          data: expect.objectContaining({ nameVi: 'Phân loại hàng hóa' }),
        });
      });

      it('확장 속성과 원본 필드를 섞어 보내면 거부한다', async () => {
        await expect(
          service.update('ITEM_TYPE', { nameVi: 'ok', nameKo: '안됨' }),
        ).rejects.toThrow(ConflictException);
        expect(prisma.codeGroup.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('remove', () => {
    it('사용중인 하위 코드값이 있으면 409', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(baseGroup);
      prisma.codeValue.count.mockResolvedValue(3);

      await expect(service.remove('ITEM_TYPE')).rejects.toThrow(ConflictException);
      expect(prisma.codeGroup.update).not.toHaveBeenCalled();
    });

    it('하위 코드값이 없으면 소프트 삭제한다', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue(baseGroup);
      prisma.codeValue.count.mockResolvedValue(0);
      prisma.codeGroup.update.mockResolvedValue(baseGroup);

      await service.remove('ITEM_TYPE');

      expect(prisma.codeGroup.update).toHaveBeenCalledWith({
        where: { code: 'ITEM_TYPE' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      });
    });

    it('ERP 연계 수신본은 삭제 불가 — 409 (원본 필드 한정 완화가 삭제에는 적용되지 않는다)', async () => {
      prisma.codeGroup.findFirst.mockResolvedValue({ ...baseGroup, source: DataSource.ERP });

      await expect(service.remove('ITEM_TYPE')).rejects.toThrow(ConflictException);
      expect(prisma.codeGroup.update).not.toHaveBeenCalled();
    });
  });
});
