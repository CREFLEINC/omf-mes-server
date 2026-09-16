import { Prisma } from '@prisma/client';

export const DOCUMENT_TARGET_TYPES = [
  'LOT',
  'SERIAL_NUMBER',
  'HANDLING_UNIT',
  'GOODS_ISSUE_LINE',
  'MOLD',
  'LOCATION',
  'INSPECTION_RESULT',
  'SHIPMENT_LOT_ALLOCATION',
  'SHIPPING_UNIT',
] as const;

export type DocumentTargetType = (typeof DOCUMENT_TARGET_TYPES)[number];
export type TargetLookup = Map<
  string,
  { displayName: string; screenId: string }
>;

interface TargetRow {
  target_type_code: string;
  target_id: bigint;
}

export function targetKey(type: string, id: bigint): string {
  return `${type}:${id}`;
}

export async function loadDocumentIssueTargets(
  tx: Prisma.TransactionClient,
  rows: TargetRow[],
): Promise<TargetLookup> {
  const ids = (type: DocumentTargetType): bigint[] => [
    ...new Set(
      rows
        .filter((row) => row.target_type_code === type)
        .map((row) => row.target_id),
    ),
  ];
  const [lots, serials, units, issueLines, molds, locations, inspections, allocations, shippingUnits] =
    await Promise.all([
      tx.lot.findMany({
        where: { lot_id: { in: ids('LOT') } },
        select: { lot_id: true, lot_no: true },
      }),
      tx.serial_number.findMany({
        where: { serial_number_id: { in: ids('SERIAL_NUMBER') } },
        select: { serial_number_id: true, serial_no: true },
      }),
      tx.handling_unit.findMany({
        where: { handling_unit_id: { in: ids('HANDLING_UNIT') } },
        select: { handling_unit_id: true, handling_unit_no: true },
      }),
      tx.goods_issue_line.findMany({
        where: { goods_issue_line_id: { in: ids('GOODS_ISSUE_LINE') } },
        select: {
          goods_issue_line_id: true,
          line_no: true,
          goods_issue: { select: { goods_issue_no: true } },
        },
      }),
      tx.mold.findMany({
        where: { mold_id: { in: ids('MOLD') } },
        select: { mold_id: true, mold_name: true },
      }),
      tx.location.findMany({
        where: { location_id: { in: ids('LOCATION') } },
        select: { location_id: true, location_name: true },
      }),
      tx.inspection_result.findMany({
        where: { inspection_result_id: { in: ids('INSPECTION_RESULT') } },
        select: { inspection_result_id: true, inspection_result_no: true },
      }),
      ids('SHIPMENT_LOT_ALLOCATION').length === 0
        ? Promise.resolve([] as Array<{ shipment_lot_allocation_id: bigint }>)
        : tx.shipment_lot_allocation.findMany({
        where: { shipment_lot_allocation_id: { in: ids('SHIPMENT_LOT_ALLOCATION') } },
        select: { shipment_lot_allocation_id: true },
      }),
      // ⛔ 배분 쪽과 같은 가드다 — 대상이 없으면 조회 자체를 하지 않는다. 유형별 호출 수를
      //    세는 시험이 있어서이기도 하고, 빈 `IN ()` 를 보내지 않기 위해서다.
      ids('SHIPPING_UNIT').length === 0
        ? Promise.resolve([] as Array<{ shipping_unit_id: bigint; shipping_unit_no: string }>)
        : tx.shipping_unit.findMany({
        where: { shipping_unit_id: { in: ids('SHIPPING_UNIT') } },
        select: { shipping_unit_id: true, shipping_unit_no: true },
      }),
    ]);

  const targets: TargetLookup = new Map();
  const add = (
    type: DocumentTargetType,
    id: bigint,
    displayName: string,
    screenId: string,
  ): void => {
    targets.set(targetKey(type, id), { displayName, screenId });
  };
  lots.forEach((row) => add('LOT', row.lot_id, row.lot_no, 'P-02-07'));
  serials.forEach((row) =>
    add('SERIAL_NUMBER', row.serial_number_id, row.serial_no, 'P-02-05'),
  );
  units.forEach((row) =>
    add('HANDLING_UNIT', row.handling_unit_id, row.handling_unit_no, 'P-02-09'),
  );
  issueLines.forEach((row) =>
    add(
      'GOODS_ISSUE_LINE',
      row.goods_issue_line_id,
      `${row.goods_issue.goods_issue_no} #${row.line_no}`,
      'P-01-02',
    ),
  );
  molds.forEach((row) => add('MOLD', row.mold_id, row.mold_name, 'W-05-13'));
  locations.forEach((row) =>
    add('LOCATION', row.location_id, row.location_name, 'W-06-07'),
  );
  inspections.forEach((row) =>
    add(
      'INSPECTION_RESULT',
      row.inspection_result_id,
      row.inspection_result_no,
      'W-04-03',
    ),
  );
  // ⛔ 배분 분기를 «남긴다» — 납품 라벨의 주인은 출하 단위로 옮겨갔지만(SHIP-UNIT-01),
  //    그전에 발행된 이력이 이 대상을 가리키고 그 표시명을 여기서 푼다. 지우면 과거 이력이
  //    「TYPE #id」 로 떨어진다. 빠지는 것은 발행 «허용 쌍»(쓰기)에서뿐이다.
  // ⚠ 표시명이 「출하 LOT 배분 #id」 로 고정된다 — 종전에는 배분의 `delivery_label_no` 를
  //    먼저 썼는데 그 칸을 폐기한다(P-27). 그 이름을 갖던 기록은 0행이라 잃는 것이 없다.
  allocations.forEach((row) => add(
    'SHIPMENT_LOT_ALLOCATION', row.shipment_lot_allocation_id,
    `출하 LOT 배분 #${row.shipment_lot_allocation_id}`, 'P-04-02',
  ));
  // ⭐ 표시명이 곧 납품 라벨 번호다 — 별도 번호를 두지 않는다.
  shippingUnits.forEach((row) => add(
    'SHIPPING_UNIT', row.shipping_unit_id, row.shipping_unit_no, 'P-04-05',
  ));
  return targets;
}
