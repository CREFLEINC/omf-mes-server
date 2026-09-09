import { Prisma } from "@prisma/client";

import {
  DocumentIssueTargetFacts,
  PreparedDocumentIssueTarget,
} from "./document-issue-create-rules";
import { targetKey } from "./document-issue-target-lookup";

type Tx = Prisma.TransactionClient;
type FactsByTarget = Map<string, DocumentIssueTargetFacts>;

interface ResultRow {
  inspection_result_id: bigint;
  inspection_request_id: bigint;
  status_code: string;
  confirmed_at: Date | null;
}

interface RequestRow {
  inspection_request_id: bigint;
  lot_id: bigint | null;
}

interface LotRow {
  lot_id: bigint;
}

/**
 * 검사 확정 writer의 실제 순서(result → request → LOT)에 맞춰 CoA 자격 원천을 잠근다.
 * SHARE는 상태·귀속을 바꾸는 UPDATE와 충돌하되 발행끼리의 동시 읽기는 허용한다.
 */
export async function lockDocumentIssueInspectionTargets(
  tx: Tx,
  targets: PreparedDocumentIssueTarget[],
): Promise<FactsByTarget> {
  const resultIds = idsOf(targets);
  if (resultIds.length === 0) return new Map();

  const results = await tx.$queryRaw<ResultRow[]>(Prisma.sql`
    SELECT inspection_result_id,inspection_request_id,status_code,confirmed_at
    FROM quality.inspection_result
    WHERE inspection_result_id IN (${joinedIds(resultIds)})
    ORDER BY inspection_result_id FOR SHARE`);
  if (results.length === 0) return new Map();

  const requestIds = uniqueSorted(
    results.map((result) => result.inspection_request_id),
  );
  const requests = await tx.$queryRaw<RequestRow[]>(Prisma.sql`
    SELECT inspection_request_id,lot_id
    FROM quality.inspection_request
    WHERE inspection_request_id IN (${joinedIds(requestIds)})
    ORDER BY inspection_request_id FOR SHARE`);
  if (requests.length !== requestIds.length) {
    throw new Error("검사 결과가 가리키는 검사 의뢰를 잠그지 못했습니다.");
  }

  const lotIds = uniqueSorted(
    requests.flatMap((request) =>
      request.lot_id === null ? [] : [request.lot_id],
    ),
  );
  if (lotIds.length > 0) {
    const lots = await tx.$queryRaw<LotRow[]>(Prisma.sql`
      SELECT lot_id
      FROM trace.lot
      WHERE lot_id IN (${joinedIds(lotIds)})
      ORDER BY lot_id FOR SHARE`);
    if (lots.length !== lotIds.length) {
      throw new Error("검사 의뢰가 가리키는 LOT을 잠그지 못했습니다.");
    }
  }

  const lotByRequest = new Map(
    requests.map((request) => [request.inspection_request_id, request.lot_id]),
  );
  return new Map(
    results.map((result) => [
      targetKey("INSPECTION_RESULT", result.inspection_result_id),
      {
        targetTypeCode: "INSPECTION_RESULT" as const,
        targetId: result.inspection_result_id,
        lotId: lotByRequest.get(result.inspection_request_id) ?? null,
        statusCode: result.status_code,
        confirmedAt: result.confirmed_at,
      },
    ]),
  );
}

function idsOf(targets: PreparedDocumentIssueTarget[]): bigint[] {
  return uniqueSorted(
    targets
      .filter((target) => target.targetTypeCode === "INSPECTION_RESULT")
      .map((target) => target.targetId),
  );
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
