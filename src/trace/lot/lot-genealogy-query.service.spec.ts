import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { LotGenealogyQueryService } from './lot-genealogy-query.service';

/** omf-all-around#166 · 장부 P-103 — 투입 자재 계보 조회. */
const hour = (h: number) => new Date(Date.UTC(2026, 9, 22, h));
const input = (id: bigint, lotId: bigint, h: number) => ({
  material_consumption_id: id,
  item_id: 41n,
  lot_id: lotId,
  occurred_at: hour(h),
  corrects_consumption_id: null,
});
const material = (lotId: bigint, change: { change_type_code: string; remarks: string | null } | null = null) => ({
  lot_id: lotId,
  lot_no: `ML-${lotId}`,
  item_id: 41n,
  item: { item_code: 'F537', item_name: 'PCB ASSY' },
  lot_four_m_change: change,
});

interface Options {
  lot?: unknown;
  serial?: unknown;
  traced?: boolean;
  relations?: bigint[];
  inputs?: unknown[];
  consumedWorkOrders?: bigint[];
  serials?: unknown[];
}

function harness(options: Options) {
  const lotFindMany = jest.fn((args: { where: { lot_id: { in: bigint[] } } }) =>
    Promise.resolve(args.where.lot_id.in.map((id) => material(id, id === 78n ? { change_type_code: 'MATERIAL', remarks: null } : null))),
  );
  const prisma = {
    lot: {
      findUnique: jest.fn().mockResolvedValue(options.lot === undefined ? { source_type_code: 'WORK_ORDER', source_id: 70n, lot_id: 5n } : options.lot),
      findMany: lotFindMany,
    },
    serial_number: {
      findUnique: jest.fn().mockResolvedValue(options.serial ?? null),
      findMany: jest.fn().mockResolvedValue(options.serials ?? []),
    },
    lot_relation: {
      findMany: jest.fn((args: { where: { target_lot_id?: bigint } }) =>
        Promise.resolve(
          args.where.target_lot_id === undefined
            ? options.traced === true
              ? [{ lot_lot_relation_target_lot_idTolot: { source_id: 70n } }]
              : []
            : (options.relations ?? []).map((source_lot_id) => ({ source_lot_id })),
        ),
      ),
    },
    material_consumption: {
      findMany: jest.fn((args: { distinct?: string[] }) => {
        if (args.distinct?.[0] === 'work_order_id') return Promise.resolve((options.consumedWorkOrders ?? []).map((work_order_id) => ({ work_order_id })));
        if (args.distinct?.[0] === 'lot_id') return Promise.resolve([{ lot_id: 77n }, { lot_id: 78n }]);
        return Promise.resolve(options.inputs ?? []);
      }),
    },
  } as unknown as PrismaService;
  return new LotGenealogyQueryService(prisma);
}

describe('LotGenealogyQueryService', () => {
  it('생산 LOT — 실적이 남긴 계보의 자재 LOT 을 4M 표시와 함께 낸다', async () => {
    const service = harness({ traced: true, relations: [78n] });

    await expect(service.ofProductionLot(5)).resolves.toEqual({
      basis: 'LOT_GENEALOGY_ESTIMATE',
      items: [{ lotId: 78, lotNo: 'ML-78', itemId: 41, itemCode: 'F537', itemName: 'PCB ASSY', fourMChange: { changeTypeCode: 'MATERIAL' } }],
    });
  });

  it('생산 LOT — 계보 없는 W/O(배포 전)는 W/O 투입 전부를 W/O 단위 추정으로 낸다', async () => {
    const service = harness({ traced: false });

    const result = await service.ofProductionLot(5);

    expect(result.basis).toBe('WORK_ORDER_ESTIMATE');
    expect(result.items.map((item) => item.lotId)).toEqual([77, 78]);
  });

  it('생산 LOT 이 아니면 빈 목록이고, 없는 LOT 은 404', async () => {
    await expect(harness({ lot: { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 1n } }).ofProductionLot(5)).resolves.toEqual({
      basis: 'LOT_GENEALOGY_ESTIMATE',
      items: [],
    });
    await expect(harness({ lot: null }).ofProductionLot(5)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('시리얼 — 생산 시각에 쓰던 자재 LOT 이다', async () => {
    const service = harness({
      traced: true,
      inputs: [input(1n, 77n, 1), input(2n, 78n, 3)],
      serial: { produced_at: hour(4), created_at: hour(0), lot: { source_type_code: 'WORK_ORDER', source_id: 70n } },
    });

    const result = await service.ofSerial('SN-1');

    expect(result.items.map((item) => item.lotId)).toEqual([78]);
  });

  it('시리얼 — 생산 시각이 없으면 발번 시각으로 본다 · 없는 시리얼은 404', async () => {
    const service = harness({
      traced: true,
      inputs: [input(1n, 77n, 1), input(2n, 78n, 3)],
      serial: { produced_at: null, created_at: hour(2), lot: { source_type_code: 'WORK_ORDER', source_id: 70n } },
    });

    expect((await service.ofSerial('SN-1')).items.map((item) => item.lotId)).toEqual([77]);
    await expect(harness({}).ofSerial('X')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('자재 LOT 의 시리얼 — 그 LOT 구간에 만든 시리얼만, 쪽으로 나눠 낸다', async () => {
    const serial = (id: number, h: number) => ({
      serial_number_id: BigInt(id),
      serial_no: `SN-${id}`,
      lot_id: 501n,
      produced_at: hour(h),
      created_at: hour(0),
      lot: { lot_no: 'P-501' },
    });
    const service = harness({
      traced: true,
      consumedWorkOrders: [70n],
      inputs: [input(1n, 5n, 1), input(2n, 78n, 3)],
      serials: [serial(1, 2), serial(2, 4), serial(3, 2)],
    });

    await expect(service.usedSerials(5, { page: 1, size: 1 })).resolves.toEqual({
      basis: 'LOT_GENEALOGY_ESTIMATE',
      items: [{ serialNumberId: 1, serialNo: 'SN-1', lotId: 501, lotNo: 'P-501', producedAt: hour(2).toISOString() }],
      page: { page: 1, size: 1, total: 2 },
    });
  });
});
