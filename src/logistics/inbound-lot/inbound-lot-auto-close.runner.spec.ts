import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { InboundLotAutoCloseRunner } from './inbound-lot-auto-close.runner';

jest.mock('./inbound-lot-close', () => ({
  ...jest.requireActual<object>('./inbound-lot-close'),
  iqcRecordOf: jest.fn().mockResolvedValue(null),
}));

describe('InboundLotAutoCloseRunner — 회차 로그', () => {
  const stale = (id: bigint) => ({ inbound_lot_id: id, plant_id: 5n, item_id: 9n, inbound_receipt_line: { inspection_required: false } });

  function runner(failing: Set<bigint>, lots = [stale(1n), stale(2n)]) {
    const prisma = {
      plant: { findMany: jest.fn().mockResolvedValue([{ plant_id: 5n, timezone_code: 'Asia/Ho_Chi_Minh' }, { plant_id: 6n, timezone_code: 'Asia/Seoul' }]) },
      inbound_lot: { findMany: jest.fn().mockImplementation(({ where }: { where: { plant_id: bigint } }) => Promise.resolve(where.plant_id === 5n ? lots : [])) },
      $transaction: jest.fn().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({
        $queryRaw: jest.fn().mockResolvedValue([{ inbound_lot_id: 1n }]),
      })),
    } as unknown as PrismaService;
    const closer = {
      closeInboundLot: jest.fn().mockImplementation((_tx: unknown, { inboundLotId }: { inboundLotId: bigint }) =>
        (failing.has(inboundLotId) ? Promise.reject(new Error('잠김')) : Promise.resolve({}))),
    };
    const lease = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };
    const instance = new InboundLotAutoCloseRunner(false, prisma, lease, closer, { next: jest.fn() });
    const logger = (instance as unknown as { logger: Logger }).logger;
    return { instance, info: jest.spyOn(logger, 'log').mockImplementation(() => undefined), warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined) };
  }

  it('G1-2-5 닫은 공장마다 info 한 줄(공장·건수), 건별 실패는 warn — 닫은 것이 없는 공장은 info 를 남기지 않는다', async () => {
    const { instance, info, warn } = runner(new Set([2n]));

    await expect(instance.tick(new Date('2026-11-12T00:00:00.000Z'))).resolves.toBe(1);

    expect(info.mock.calls).toEqual([['날짜 자동 마감 — 공장 5: 1건']]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('입하 LOT 2');
  });

  it('G1-2-5 닫은 것이 없으면 info 를 남기지 않는다', async () => {
    const { instance, info } = runner(new Set(), []);

    await expect(instance.tick(new Date('2026-11-12T00:00:00.000Z'))).resolves.toBe(0);

    expect(info).not.toHaveBeenCalled();
  });
});
