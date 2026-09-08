import { Prisma } from '@prisma/client';

export const DOCUMENT_TARGET_TYPES = [
  'LOT',
  'SERIAL_NUMBER',
  'HANDLING_UNIT',
  'GOODS_ISSUE_LINE',
  'MOLD',
  'LOCATION',
  'INSPECTION_RESULT',
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
  const [lots, serials, units, issueLines, molds, locations, inspections] =
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
  return targets;
}
