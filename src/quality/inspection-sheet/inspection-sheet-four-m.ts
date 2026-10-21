import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `InspectionSheet.fourMChanges` 한 줄 — 그 W/O 에 투입된 4M 변경품 자재 LOT. */
export interface InspectionSheetFourMView {
  lotNo: string;
  itemCode: string;
  itemName: string;
  changeTypeCode: string;
  remarks: string | null;
}

/**
 * 검사표 머리의 「변경품」(omf-all-around#89 S4 · #63 의 자재 LOT 4M 기록) — 시리얼의 W/O 에 투입된 자재 LOT 중
 * 4M 변경품인 것. ⚠ 시리얼별 투입 기록이 없어 W/O 단위다(#63 의 생산 LOT 추정과 같은 근거 · 설계 문의 052).
 * 같은 LOT 을 여러 번 투입했어도 한 줄이다.
 */
export async function fourMChangesOf(prisma: PrismaService, workOrderId: bigint | null): Promise<InspectionSheetFourMView[]> {
  if (workOrderId === null) return [];
  const rows = await prisma.material_consumption.findMany({
    where: { work_order_id: workOrderId, lot: { lot_four_m_change: { isNot: null } } },
    select: {
      lot: {
        select: {
          lot_no: true,
          item: { select: { item_code: true, item_name: true } },
          lot_four_m_change: { select: { change_type_code: true, remarks: true } },
        },
      },
    },
    orderBy: { material_consumption_id: 'asc' },
  });
  const seen = new Set<string>();
  return rows.flatMap(({ lot }) => {
    if (lot.lot_four_m_change === null || seen.has(lot.lot_no)) return [];
    seen.add(lot.lot_no);
    return [
      {
        lotNo: lot.lot_no,
        itemCode: lot.item.item_code,
        itemName: lot.item.item_name,
        changeTypeCode: lot.lot_four_m_change.change_type_code,
        remarks: lot.lot_four_m_change.remarks,
      },
    ];
  });
}
