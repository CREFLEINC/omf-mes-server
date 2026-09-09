import { Prisma } from "@prisma/client";

import {
  DocumentIssueTargetFacts,
  PreparedDocumentIssueTarget,
} from "./document-issue-create-rules";
import { targetKey } from "./document-issue-target-lookup";

type Tx = Prisma.TransactionClient;
type FactsByTarget = Map<string, DocumentIssueTargetFacts>;

interface LinePathRow {
  goods_issue_line_id: bigint;
  goods_issue_id: bigint;
  lot_id: bigint;
}

interface HeaderRow {
  goods_issue_id: bigint;
  status_code: string;
}

interface LotRow {
  lot_id: bigint;
}

/** 부모 잠금 전후의 출고 라인 경로가 달라지면 실패한 tx 전체를 다시 시작한다. */
export class DocumentIssueGoodsIssuePathChanged extends Error {}

/**
 * 출고 writer와 같은 부모 축을 먼저 잠그고 라인→LOT 경로를 잠금 뒤 다시 확정한다.
 * 최초 조회에서 없는 라인은 정상적인 미존재 입력이므로 facts에서만 빠진다.
 */
export async function lockDocumentIssueGoodsIssueTargets(
  tx: Tx,
  targets: PreparedDocumentIssueTarget[],
): Promise<FactsByTarget> {
  const lineIds = idsOf(targets);
  if (lineIds.length === 0) return new Map();

  const first = await readLines(tx, lineIds);
  if (first.length === 0) return new Map();

  const headerIds = uniqueSorted(first.map((row) => row.goods_issue_id));
  const headers = await tx.$queryRaw<HeaderRow[]>(Prisma.sql`
    SELECT goods_issue_id,status_code
    FROM logistics.goods_issue
    WHERE goods_issue_id IN (${joinedIds(headerIds)})
    ORDER BY goods_issue_id FOR NO KEY UPDATE`);
  if (headers.length !== headerIds.length)
    throw new DocumentIssueGoodsIssuePathChanged();

  const locked = await readLines(tx, lineIds);
  if (pathKey(first) !== pathKey(locked))
    throw new DocumentIssueGoodsIssuePathChanged();

  const lotIds = uniqueSorted(locked.map((row) => row.lot_id));
  const lots = await tx.$queryRaw<LotRow[]>(Prisma.sql`
    SELECT lot_id
    FROM trace.lot
    WHERE lot_id IN (${joinedIds(lotIds)})
    ORDER BY lot_id FOR NO KEY UPDATE`);
  if (lots.length !== lotIds.length)
    throw new DocumentIssueGoodsIssuePathChanged();

  const statusByHeader = new Map(
    headers.map((row) => [row.goods_issue_id.toString(), row.status_code]),
  );
  return new Map(
    locked.map((row) => [
      targetKey("GOODS_ISSUE_LINE", row.goods_issue_line_id),
      {
        targetTypeCode: "GOODS_ISSUE_LINE" as const,
        targetId: row.goods_issue_line_id,
        lotId: row.lot_id,
        goodsIssueStatusCode: statusByHeader.get(
          row.goods_issue_id.toString(),
        ) as string,
      },
    ]),
  );
}

async function readLines(tx: Tx, ids: bigint[]): Promise<LinePathRow[]> {
  return tx.$queryRaw<LinePathRow[]>(Prisma.sql`
    SELECT goods_issue_line_id,goods_issue_id,lot_id
    FROM logistics.goods_issue_line
    WHERE goods_issue_line_id IN (${joinedIds(ids)})
    ORDER BY goods_issue_line_id`);
}

function idsOf(targets: PreparedDocumentIssueTarget[]): bigint[] {
  return uniqueSorted(
    targets
      .filter((target) => target.targetTypeCode === "GOODS_ISSUE_LINE")
      .map((target) => target.targetId),
  );
}

function pathKey(rows: LinePathRow[]): string {
  return rows
    .map(
      (row) => `${row.goods_issue_line_id}:${row.goods_issue_id}:${row.lot_id}`,
    )
    .join("|");
}

function uniqueSorted(ids: bigint[]): bigint[] {
  return [...new Set(ids)].sort(bigintOrder);
}

function joinedIds(ids: bigint[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::bigint`));
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
