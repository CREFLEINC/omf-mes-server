import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { shift } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OrganizationService } from '../organization/organization.service';
import { fromTimeValue, ShiftService, toTimeValue } from './shift.service';

const baseShift: shift = {
  shift_id: 1n,
  plant_id: 1n,
  shift_code: 'SHIFT_A',
  shift_name: '주간조',
  start_time: toTimeValue('08:00'),
  end_time: toTimeValue('17:00'),
  crosses_midnight: false,
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('시각 변환', () => {
  it('HH:MM을 UTC epoch 시각으로 바꾼다 — time 컬럼은 UTC 축으로 읽고 쓴다', () => {
    expect(toTimeValue('22:00').toISOString()).toBe('1970-01-01T22:00:00.000Z');
    expect(toTimeValue('06:30:15').toISOString()).toBe('1970-01-01T06:30:15.000Z');
  });

  it('되읽으면 HH:MM:SS가 된다 — 왕복이 손실 없다', () => {
    expect(fromTimeValue(toTimeValue('22:00'))).toBe('22:00:00');
    expect(fromTimeValue(toTimeValue('06:30:15'))).toBe('06:30:15');
  });
});

describe('ShiftService', () => {
  let service: ShiftService;
  let prisma: { shift: Record<string, jest.Mock>; $transaction: jest.Mock };
  const org = { findPlant: jest.fn() };

  beforeEach(async () => {
    org.findPlant.mockResolvedValue({ plant_id: 1n });
    prisma = {
      shift: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ShiftService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrganizationService, useValue: org },
      ],
    }).compile();

    service = moduleRef.get(ShiftService);
  });

  const newShift = {
    legalEntityCode: 'OMF_VN',
    plantCode: 'PLANT1',
    shiftCode: 'SHIFT_A',
    shiftName: '주간조',
    startTime: '08:00',
    endTime: '17:00',
  };

  // DDL에 제약이 없어 앱에서만 막는다. 야간조를 crossesMidnight=false로 저장하면
  // 근무 길이가 음수가 되어 이후 집계가 조용히 틀어진다.
  describe('자정 넘김 판정', () => {
    it('종료가 시작보다 이르면 자동으로 true', async () => {
      prisma.shift.findUnique.mockResolvedValue(null);
      prisma.shift.create.mockResolvedValue(baseShift);

      await service.create({ ...newShift, startTime: '22:00', endTime: '06:00' });

      expect(prisma.shift.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ crosses_midnight: true }),
      });
    });

    it('종료가 시작보다 늦으면 자동으로 false', async () => {
      prisma.shift.findUnique.mockResolvedValue(null);
      prisma.shift.create.mockResolvedValue(baseShift);

      await service.create(newShift);

      expect(prisma.shift.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ crosses_midnight: false }),
      });
    });

    it('시각과 어긋나는 값을 보내면 400', async () => {
      prisma.shift.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ ...newShift, startTime: '22:00', endTime: '06:00', crossesMidnight: false }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.create({ ...newShift, crossesMidnight: true }),
      ).rejects.toThrow(BadRequestException);
    });

    it('시작과 종료가 같으면 400 — 근무 길이를 판정할 수 없다', async () => {
      prisma.shift.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ ...newShift, startTime: '08:00', endTime: '08:00' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('수정으로 시각만 바꿔도 재판정한다', async () => {
      prisma.shift.findMany.mockResolvedValue([baseShift]);
      prisma.shift.update.mockResolvedValue({ ...baseShift, crosses_midnight: true });

      await service.update('SHIFT_A', { endTime: '02:00' });

      expect(prisma.shift.update).toHaveBeenCalledWith({
        where: { shift_id: 1n },
        data: expect.objectContaining({ crosses_midnight: true }),
      });
    });
  });

  it('응답의 시각은 HH:MM:SS 문자열이다', async () => {
    prisma.shift.findMany.mockResolvedValue([baseShift]);

    const view = await service.findOne('SHIFT_A');

    expect(view.start_time).toBe('08:00:00');
    expect(view.end_time).toBe('17:00:00');
  });
});
