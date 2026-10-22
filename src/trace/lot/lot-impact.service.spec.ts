import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { LotImpactService } from './lot-impact.service';

/** omf-all-around#108 — 자재 LOT → 생산 LOT(장부 P-52) · 계보 기준(#166 · P-107). */
describe('LotImpactService', () => {
  const service = (consumptions: unknown[], lots: unknown[], exists = true, traced: bigint[] = [], related: bigint[] = []) => {
    const lotFindMany = jest.fn().mockResolvedValue(lots);
    const relationFindMany = jest.fn((args: { where: { source_lot_id?: bigint } }) =>
      Promise.resolve(
        args.where.source_lot_id === undefined
          ? traced.map((source_id) => ({ lot_lot_relation_target_lot_idTolot: { source_id } }))
          : related.map((target_lot_id) => ({ target_lot_id })),
      ),
    );
    const prisma = {
      lot_relation: { findMany: relationFindMany },
      lot: { findUnique: jest.fn().mockResolvedValue(exists ? { lot_id: 5n } : null), findMany: lotFindMany },
      material_consumption: { findMany: jest.fn().mockResolvedValue(consumptions) },
    } as unknown as PrismaService;
    return { impacts: new LotImpactService(prisma), lotFindMany };
  };

  it('투입된 작업지시의 생산 LOT 전부를 추정으로 낸다', async () => {
    const { impacts, lotFindMany } = service(
      [{ work_order: { work_order_id: 41n, work_order_no: 'WO-41' } }],
      [{ lot_id: 90n, lot_no: 'P-90', item_id: 7n, status_code: 'NORMAL', source_id: 41n }],
    );
    await expect(impacts.affectedProductionLots(5)).resolves.toEqual({
      basis: 'WORK_ORDER_ESTIMATE',
      workOrders: [{ workOrderId: 41, workOrderNo: 'WO-41' }],
      items: [{ lotId: 90, lotNo: 'P-90', itemId: 7, statusCode: 'NORMAL', workOrderId: 41, workOrderNo: 'WO-41' }],
    });
    expect(lotFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        source_type_code: 'WORK_ORDER',
        OR: [{ source_id: { in: [41n] } }, { source_id: { in: [] }, lot_id: { in: [] } }],
      },
    }));
  });

  it('계보가 있는 작업지시는 이어진 생산 LOT 만 낸다(#166)', async () => {
    const { impacts, lotFindMany } = service(
      [{ work_order: { work_order_id: 41n, work_order_no: 'WO-41' } }],
      [{ lot_id: 90n, lot_no: 'P-90', item_id: 7n, status_code: 'NORMAL', source_id: 41n }],
      true,
      [41n],
      [90n],
    );
    await expect(impacts.affectedProductionLots(5)).resolves.toMatchObject({ basis: 'LOT_GENEALOGY_ESTIMATE' });
    expect(lotFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        source_type_code: 'WORK_ORDER',
        OR: [{ source_id: { in: [] } }, { source_id: { in: [41n] }, lot_id: { in: [90n] } }],
      },
    }));
  });

  it('투입 기록이 없으면 빈 범위다 — 생산 LOT 을 묻지 않는다', async () => {
    const { impacts, lotFindMany } = service([], []);
    await expect(impacts.affectedProductionLots(5)).resolves.toMatchObject({ workOrders: [], items: [] });
    expect(lotFindMany).not.toHaveBeenCalled();
  });

  it('없는 LOT 은 404', async () => {
    await expect(service([], [], false).impacts.affectedProductionLots(5)).rejects.toBeInstanceOf(NotFoundException);
  });
});
