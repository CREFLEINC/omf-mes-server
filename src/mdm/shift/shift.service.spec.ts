import { NotFoundException } from '@nestjs/common';

import { plantScopeFor } from '../../planning/production-order/production-order-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { ShiftService } from './shift.service';

jest.mock('../../planning/production-order/production-order-scope', () => ({
  plantScopeFor: jest.fn().mockResolvedValue(null),
}));

const time = (value: string): Date => new Date(`1970-01-01T${value}Z`);

const row = (over: object = {}) => ({
  shift_id: 7n,
  plant_id: 2n,
  shift_code: 'N',
  shift_name: '야간',
  start_time: time('20:00:00'),
  end_time: time('08:00:00'),
  crosses_midnight: true,
  is_active: true,
  version_no: 3,
  ...over,
});

/** 교대 관리(omf-all-around#318) — 등록·수정·중지. DB 는 흉내 낸다(실 DB 확인은 e2e·실검증). */
describe('ShiftService', () => {
  const setup = (references = 0) => {
    const tx = {
      plant: { findUnique: jest.fn().mockResolvedValue({ plant_id: 2n }) },
      shift: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
        findUnique: jest.fn().mockResolvedValue(row()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ total: BigInt(references) }]),
    };
    const prisma = { ...tx, $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    return { tx, service: new ShiftService(prisma as unknown as PrismaService) };
  };

  beforeEach(() => jest.mocked(plantScopeFor).mockClear());

  it('자정 넘김은 시각으로 정한다 — 끝이 시작보다 이르면 넘는다, 늦으면 안 넘는다', async () => {
    const { tx, service } = setup();
    await service.create(tx as never, 1, { plantId: 2, shiftCode: 'N', shiftName: '야간', startTime: '20:00:00', endTime: '08:00:00' });
    await service.create(tx as never, 1, { plantId: 2, shiftCode: 'D', shiftName: '주간', startTime: '08:00:00', endTime: '20:00:00' });
    expect(tx.shift.create.mock.calls.map(([arg]) => arg.data.crosses_midnight)).toEqual([true, false]);
    expect(tx.shift.create.mock.calls[1][0].data).toMatchObject({ plant_id: 2, start_time: time('08:00:00'), end_time: time('20:00:00'), created_by: 1 });
  });

  it('등록은 요청자 데이터 범위로 공장을 확인한다 — 범위 밖이면 저장하지 않는다', async () => {
    const { tx, service } = setup();
    jest.mocked(plantScopeFor).mockRejectedValueOnce(new Error('403'));
    await expect(
      service.create(tx as never, 1, { plantId: 2, shiftCode: 'D', shiftName: '주간', startTime: '08:00:00', endTime: '20:00:00' }),
    ).rejects.toThrow('403');
    expect(plantScopeFor).toHaveBeenCalledWith(tx, 1, 2);
    expect(tx.shift.create).not.toHaveBeenCalled();
  });

  it('없는 공장 · 공백 이름은 400 이다', async () => {
    const { tx, service } = setup();
    tx.plant.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.create(tx as never, 1, { plantId: 9, shiftCode: 'D', shiftName: '주간', startTime: '08:00:00', endTime: '20:00:00' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(tx as never, 1, { plantId: 2, shiftCode: 'D', shiftName: '  ', startTime: '08:00:00', endTime: '20:00:00' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.shift.create).not.toHaveBeenCalled();
  });

  it('수정은 version_no 를 조건에 걸고 시각·이름을 바꾼다', async () => {
    const { tx, service } = setup();
    const detail = await service.update(1, 7, 3, { shiftName: '야간 2', startTime: '21:00:00', endTime: '07:00:00' });
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { shift_id: 7, version_no: 3 },
      data: expect.objectContaining({ shift_name: '야간 2', start_time: time('21:00:00'), end_time: time('07:00:00'), crosses_midnight: true, updated_by: 1 }),
    });
    expect(detail.editability).toEqual({ codeEditable: true, reason: 'EDITABLE', referenceCount: 0 });
  });

  it('작업·실적에 쓰인 교대는 코드를 바꾸지 못한다 — 같은 코드를 다시 보내는 것은 된다', async () => {
    const { tx, service } = setup(4);
    await expect(service.update(1, 7, 3, { shiftCode: 'NX', shiftName: '야간', startTime: '20:00:00', endTime: '08:00:00' })).rejects.toMatchObject({ status: 400 });
    expect(tx.shift.updateMany).not.toHaveBeenCalled();
    await service.update(1, 7, 3, { shiftCode: 'N', shiftName: '야간', startTime: '20:00:00', endTime: '08:00:00' });
    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1);
  });

  it('그 사이 누가 먼저 고쳤으면(0행) 409 다', async () => {
    const { tx, service } = setup();
    tx.shift.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.deactivate(1, 7, 2)).rejects.toMatchObject({ status: 409 });
  });

  it('사용 중지는 행을 지우지 않고 is_active 만 끈다 · 범위는 교대의 공장으로 본다', async () => {
    const { tx, service } = setup();
    await service.deactivate(1, 7, 3);
    expect(plantScopeFor).toHaveBeenCalledWith(tx, 1, 2);
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { shift_id: 7, version_no: 3 },
      data: expect.objectContaining({ is_active: false }),
    });
  });

  it('시작과 종료가 같은 시각이면 등록·수정 모두 400 이고 저장하지 않는다', async () => {
    const { tx, service } = setup();
    await expect(
      service.create(tx as never, 1, { plantId: 2, shiftCode: 'E', shiftName: '같음', startTime: '08:00:00', endTime: '08:00:00' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.update(1, 7, 3, { shiftName: '같음', startTime: '20:00:00', endTime: '20:00:00' })).rejects.toMatchObject({ status: 400 });
    expect(tx.shift.create).not.toHaveBeenCalled();
    expect(tx.shift.updateMany).not.toHaveBeenCalled();
  });

  it('다시 사용은 is_active 를 켜고 version_no 를 조건에 건다 · 범위는 교대의 공장으로 본다', async () => {
    const { tx, service } = setup();
    await service.activate(1, 7, 3);
    expect(plantScopeFor).toHaveBeenCalledWith(tx, 1, 2);
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { shift_id: 7, version_no: 3 },
      data: expect.objectContaining({ is_active: true }),
    });
    tx.shift.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.activate(1, 7, 2)).rejects.toMatchObject({ status: 409 });
  });

  it('없는 교대는 404 다', async () => {
    const { tx, service } = setup();
    tx.shift.findUnique.mockResolvedValueOnce(null);
    await expect(service.deactivate(1, 99, 1)).rejects.toBeInstanceOf(NotFoundException);
  });
});
