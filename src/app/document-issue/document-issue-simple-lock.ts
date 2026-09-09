import { Prisma } from "@prisma/client";

import {
  DocumentIssueDocumentType,
  DocumentIssueTargetFacts,
  PreparedDocumentIssueTarget,
} from "./document-issue-create-rules";
import { targetKey } from "./document-issue-target-lookup";

type Tx = Prisma.TransactionClient;
type FactsByTarget = Map<string, DocumentIssueTargetFacts>;

interface LotRow {
  lot_id: bigint;
  lot_type_code: string;
  status_code: string;
  completed_at: Date | null;
  source_type_code: string;
  source_id: bigint;
}

interface SerialRow {
  serial_number_id: bigint;
  lot_id: bigint;
}

interface IdRow {
  target_id: bigint;
}

interface UnitContentRow {
  handling_unit_id: bigint;
}

/**
 * 단일 표에서 끝나는 발행 대상을 ID 오름차순으로 잠근다.
 * 출고 라인과 검사 결과는 교차 writer 잠금 순서가 달라 후속 C2 조각이 소유한다.
 */
export async function lockSimpleDocumentIssueTargets(
  tx: Tx,
  documentTypeCode: DocumentIssueDocumentType,
  targets: PreparedDocumentIssueTarget[],
): Promise<FactsByTarget> {
  const facts: FactsByTarget = new Map();
  await lockLots(tx, idsOf(targets, "LOT"), facts);
  await lockSerials(tx, idsOf(targets, "SERIAL_NUMBER"), facts);
  await lockUnits(
    tx,
    idsOf(targets, "HANDLING_UNIT"),
    documentTypeCode === "GOODS_ISSUE_QR",
    facts,
  );
  await lockMolds(tx, idsOf(targets, "MOLD"), facts);
  await lockLocations(tx, idsOf(targets, "LOCATION"), facts);
  return facts;
}

async function lockLots(
  tx: Tx,
  ids: bigint[],
  facts: FactsByTarget,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<LotRow[]>(Prisma.sql`
    SELECT lot_id,lot_type_code,status_code,completed_at,source_type_code,source_id
    FROM trace.lot
    WHERE lot_id IN (${joinedIds(ids)})
    ORDER BY lot_id FOR NO KEY UPDATE`);
  rows.forEach((row) =>
    facts.set(targetKey("LOT", row.lot_id), {
      targetTypeCode: "LOT",
      targetId: row.lot_id,
      lotTypeCode: row.lot_type_code,
      statusCode: row.status_code,
      completedAt: row.completed_at,
      sourceTypeCode: row.source_type_code,
      sourceId: row.source_id,
    }),
  );
}

async function lockSerials(
  tx: Tx,
  ids: bigint[],
  facts: FactsByTarget,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<SerialRow[]>(Prisma.sql`
    SELECT serial_number_id,lot_id
    FROM trace.serial_number
    WHERE serial_number_id IN (${joinedIds(ids)})
    ORDER BY serial_number_id FOR NO KEY UPDATE`);
  rows.forEach((row) =>
    facts.set(targetKey("SERIAL_NUMBER", row.serial_number_id), {
      targetTypeCode: "SERIAL_NUMBER",
      targetId: row.serial_number_id,
      lotId: row.lot_id,
    }),
  );
}

async function lockUnits(
  tx: Tx,
  ids: bigint[],
  needsContents: boolean,
  facts: FactsByTarget,
): Promise<void> {
  if (ids.length === 0) return;
  const units = await tx.$queryRaw<IdRow[]>(Prisma.sql`
    SELECT handling_unit_id AS target_id
    FROM inventory.handling_unit
    WHERE handling_unit_id IN (${joinedIds(ids)})
    ORDER BY handling_unit_id FOR NO KEY UPDATE`);
  let contentIds = new Set<string>();
  if (needsContents) {
    const contents = await tx.$queryRaw<UnitContentRow[]>(Prisma.sql`
      SELECT handling_unit_id
      FROM inventory.handling_unit_content
      WHERE handling_unit_id IN (${joinedIds(ids)})
      ORDER BY handling_unit_id,handling_unit_content_id FOR SHARE`);
    contentIds = new Set(
      contents.map((row) => row.handling_unit_id.toString()),
    );
  }
  units.forEach((row) =>
    facts.set(targetKey("HANDLING_UNIT", row.target_id), {
      targetTypeCode: "HANDLING_UNIT",
      targetId: row.target_id,
      ...(needsContents
        ? { hasContent: contentIds.has(row.target_id.toString()) }
        : {}),
    }),
  );
}

async function lockMolds(
  tx: Tx,
  ids: bigint[],
  facts: FactsByTarget,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<IdRow[]>(Prisma.sql`
    SELECT mold_id AS target_id
    FROM mdm.mold
    WHERE mold_id IN (${joinedIds(ids)})
    ORDER BY mold_id FOR NO KEY UPDATE`);
  rows.forEach((row) =>
    facts.set(targetKey("MOLD", row.target_id), {
      targetTypeCode: "MOLD",
      targetId: row.target_id,
    }),
  );
}

async function lockLocations(
  tx: Tx,
  ids: bigint[],
  facts: FactsByTarget,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<IdRow[]>(Prisma.sql`
    SELECT location_id AS target_id
    FROM mdm.location
    WHERE location_id IN (${joinedIds(ids)})
    ORDER BY location_id FOR NO KEY UPDATE`);
  rows.forEach((row) =>
    facts.set(targetKey("LOCATION", row.target_id), {
      targetTypeCode: "LOCATION",
      targetId: row.target_id,
    }),
  );
}

function idsOf(
  targets: PreparedDocumentIssueTarget[],
  type: PreparedDocumentIssueTarget["targetTypeCode"],
): bigint[] {
  return [
    ...new Set(
      targets
        .filter((target) => target.targetTypeCode === type)
        .map((target) => target.targetId),
    ),
  ].sort(bigintOrder);
}

function joinedIds(ids: bigint[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::bigint`));
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
