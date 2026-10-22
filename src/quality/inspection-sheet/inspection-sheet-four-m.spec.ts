import { PrismaService } from '../../prisma/prisma.service';
import { fourMChangesOf } from './inspection-sheet-four-m';

/** omf-all-around#89 S4 — 검사표 머리의 변경품(W/O 에 투입된 4M 변경품 자재 LOT). */
const lot = (lotNo: string, change: { change_type_code: string | null; remarks: string | null } | null) => ({
  lot: { lot_no: lotNo, item: { item_code: 'F537', item_name: 'PCB ASSY' }, lot_four_m_change: change },
});

describe('fourMChangesOf', () => {
  it('W/O 가 없으면 조회하지 않고 빈 목록이다', async () => {
    const prisma = { material_consumption: { findMany: jest.fn() } };

    await expect(fourMChangesOf(prisma as unknown as PrismaService, null)).resolves.toEqual([]);
    expect(prisma.material_consumption.findMany).not.toHaveBeenCalled();
  });

  it('그 W/O 의 4M 변경품 투입 LOT 을 한 번씩만 싣는다', async () => {
    const change = { change_type_code: 'MATERIAL', remarks: '공급처 변경' };
    const prisma = {
      material_consumption: { findMany: jest.fn().mockResolvedValue([lot('L-1', change), lot('L-1', change), lot('L-2', null)]) },
    };

    await expect(fourMChangesOf(prisma as unknown as PrismaService, 70n)).resolves.toEqual([
      { lotNo: 'L-1', itemCode: 'F537', itemName: 'PCB ASSY', changeTypeCode: 'MATERIAL', remarks: '공급처 변경' },
    ]);
    expect(prisma.material_consumption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { work_order_id: 70n, lot: { lot_four_m_change: { isNot: null } } } }),
    );
  });

  it('변경 종류가 없으면 종류 칸이 없다(#133)', async () => {
    const prisma = {
      material_consumption: {
        findMany: jest.fn().mockResolvedValue([lot('L-1', { change_type_code: null, remarks: '공급처 변경' })]),
      },
    };

    await expect(fourMChangesOf(prisma as unknown as PrismaService, 70n)).resolves.toEqual([
      { lotNo: 'L-1', itemCode: 'F537', itemName: 'PCB ASSY', remarks: '공급처 변경' },
    ]);
  });
});
