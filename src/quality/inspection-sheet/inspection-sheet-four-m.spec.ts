import { PrismaService } from '../../prisma/prisma.service';
import { fourMChangesOf } from './inspection-sheet-four-m';

/** omf-all-around#89 S4 — 검사표 머리의 변경품 · #166 시리얼 계보 기준(W/O 에 계보가 없으면 W/O 단위). #133 변경 종류 선택. */
const lot = (lotNo: string, change: { change_type_code: string | null; remarks: string | null } | null) => ({
  lot: { lot_no: lotNo, item: { item_code: 'F537', item_name: 'PCB ASSY' }, lot_four_m_change: change },
});
const input = (id: bigint, lotId: bigint, hour: number) => ({
  material_consumption_id: id,
  item_id: 41n,
  lot_id: lotId,
  occurred_at: new Date(Date.UTC(2026, 9, 22, hour)),
  corrects_consumption_id: null,
});

const harness = (sheetRows: unknown[], options: { traced?: boolean; inputs?: unknown[] } = {}) => {
  const findMany = jest.fn((args: { select: Record<string, unknown> }) =>
    Promise.resolve('lot' in args.select ? sheetRows : (options.inputs ?? [])),
  );
  const prisma = {
    serial_number: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ produced_at: new Date(Date.UTC(2026, 9, 22, 2)), created_at: new Date(0) }),
    },
    lot_relation: {
      findMany: jest.fn().mockResolvedValue(options.traced === true ? [{ lot_lot_relation_target_lot_idTolot: { source_id: 70n } }] : []),
    },
    material_consumption: { findMany },
  };
  return { prisma: prisma as unknown as PrismaService, findMany };
};

describe('fourMChangesOf', () => {
  it('W/O 가 없으면 조회하지 않고 빈 목록이다', async () => {
    const { prisma, findMany } = harness([]);

    await expect(fourMChangesOf(prisma, null, 1n)).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('계보가 없는 W/O — 그 W/O 의 4M 변경품 투입 LOT 을 한 번씩만 싣는다', async () => {
    const change = { change_type_code: 'MATERIAL', remarks: '공급처 변경' };
    const { prisma, findMany } = harness([lot('L-1', change), lot('L-1', change), lot('L-2', null)]);

    await expect(fourMChangesOf(prisma, 70n, 1n)).resolves.toEqual([
      { lotNo: 'L-1', itemCode: 'F537', itemName: 'PCB ASSY', changeTypeCode: 'MATERIAL', remarks: '공급처 변경' },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { work_order_id: 70n, lot: { lot_four_m_change: { isNot: null } } } }),
    );
  });

  it('계보가 있는 W/O — 시리얼 생산 시각에 쓰던 자재 LOT 만 본다(#166)', async () => {
    const { prisma, findMany } = harness([], { traced: true, inputs: [input(1n, 77n, 1), input(2n, 78n, 3)] });

    await fourMChangesOf(prisma, 70n, 1n);

    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { work_order_id: 70n, lot: { lot_four_m_change: { isNot: null } }, lot_id: { in: [77n] } },
      }),
    );
  });

  it('변경 종류가 없으면 종류 칸이 없다(#133)', async () => {
    const { prisma } = harness([lot('L-1', { change_type_code: null, remarks: '공급처 변경' })]);

    await expect(fourMChangesOf(prisma, 70n, 1n)).resolves.toEqual([
      { lotNo: 'L-1', itemCode: 'F537', itemName: 'PCB ASSY', remarks: '공급처 변경' },
    ]);
  });
});
