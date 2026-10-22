import { INPUT_ROW_SELECT, inputWindows, lotsAt, madeAt, tracedWorkOrders } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `InspectionSheet.fourMChanges` 한 줄 — 그 W/O 에 투입된 4M 변경품 자재 LOT. */
export interface InspectionSheetFourMView {
  lotNo: string;
  itemCode: string;
  itemName: string;
  /** 변경 종류 — 비면 키가 없다(#133 · P-105). */
  changeTypeCode?: string;
  remarks: string | null;
}

/**
 * 검사표 머리의 「변경품」(omf-all-around#89 S4 · #63 의 자재 LOT 4M 기록) — 그 시리얼에 들어간 자재 LOT 중 4M 변경품인 것.
 * 투입 시각 기준 계보(#166 · P-107)로 시리얼의 생산 시각에 쓰던 LOT 을 고른다. 계보가 없는 W/O(#166 배포 전)는
 * 그 W/O 에 투입된 것 전부다(W/O 단위). 같은 LOT 을 여러 번 투입했어도 한 줄이다.
 */
export async function fourMChangesOf(
  prisma: PrismaService,
  workOrderId: bigint | null,
  serialNumberId: bigint,
): Promise<InspectionSheetFourMView[]> {
  if (workOrderId === null) return [];
  const [serial, traced] = await Promise.all([
    prisma.serial_number.findUniqueOrThrow({
      where: { serial_number_id: serialNumberId },
      select: { produced_at: true, created_at: true },
    }),
    tracedWorkOrders(prisma, [workOrderId]),
  ]);
  const lotIds = traced.has(workOrderId)
    ? lotsAt(
        inputWindows(await prisma.material_consumption.findMany({ where: { work_order_id: workOrderId }, select: INPUT_ROW_SELECT })),
        madeAt(serial),
      ).map((w) => w.lotId)
    : undefined;
  const rows = await prisma.material_consumption.findMany({
    where: {
      work_order_id: workOrderId,
      lot: { lot_four_m_change: { isNot: null } },
      ...(lotIds === undefined ? {} : { lot_id: { in: lotIds } }),
    },
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
        ...(lot.lot_four_m_change.change_type_code === null
          ? {}
          : { changeTypeCode: lot.lot_four_m_change.change_type_code }),
        remarks: lot.lot_four_m_change.remarks,
      },
    ];
  });
}
