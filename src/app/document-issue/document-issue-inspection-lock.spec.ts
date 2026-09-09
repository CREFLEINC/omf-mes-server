import { Prisma } from "@prisma/client";

import { PreparedDocumentIssueTarget } from "./document-issue-create-rules";
import { lockDocumentIssueInspectionTargets } from "./document-issue-inspection-lock";
import { targetKey } from "./document-issue-target-lookup";

describe("발행 검사 결과 교차 잠금 (I-27 CoA)", () => {
  it("품질 writer와 같은 result→request→LOT 순으로 잠그고 확정 사실을 반환한다", async () => {
    const confirmedAt = new Date("2026-09-09T01:02:03Z");
    const setup = fake([
      [result(3n, 30n, "CONFIRMED", confirmedAt), result(7n, 20n)],
      [request(20n, null), request(30n, 80n)],
      [{ lot_id: 80n }],
    ]);

    const facts = await lockDocumentIssueInspectionTargets(setup.tx, [
      target(7n),
      target(3n),
    ]);

    expect(setup.sql).toEqual([
      expect.stringMatching(
        /quality\.inspection_result[\s\S]*ORDER BY inspection_result_id FOR SHARE/,
      ),
      expect.stringMatching(
        /quality\.inspection_request[\s\S]*ORDER BY inspection_request_id FOR SHARE/,
      ),
      expect.stringMatching(/trace\.lot[\s\S]*ORDER BY lot_id FOR SHARE/),
    ]);
    expect(setup.values).toEqual([[3n, 7n], [20n, 30n], [80n]]);
    expect(facts.get(targetKey("INSPECTION_RESULT", 3n))).toEqual({
      targetTypeCode: "INSPECTION_RESULT",
      targetId: 3n,
      lotId: 80n,
      statusCode: "CONFIRMED",
      confirmedAt,
    });
    expect(facts.get(targetKey("INSPECTION_RESULT", 7n))).toMatchObject({
      lotId: null,
      statusCode: "DRAFT",
      confirmedAt: null,
    });
  });

  it("없는 결과는 정상 미존재 사실이며 빈 IN 후속 질의를 만들지 않는다", async () => {
    const setup = fake([[]]);

    await expect(
      lockDocumentIssueInspectionTargets(setup.tx, [target(404n)]),
    ).resolves.toEqual(new Map());
    expect(setup.sql).toHaveLength(1);
  });

  it("검사 결과 대상이 없으면 질의를 실행하지 않는다", async () => {
    const setup = fake([]);

    await expect(
      lockDocumentIssueInspectionTargets(setup.tx, []),
    ).resolves.toEqual(new Map());
    expect(setup.sql).toEqual([]);
  });

  it("FK 경로를 전부 잠그지 못하면 부분 사실을 만들지 않는다", async () => {
    const requestGone = fake([[result(3n, 30n)], []]);
    await expect(
      lockDocumentIssueInspectionTargets(requestGone.tx, [target(3n)]),
    ).rejects.toThrow("검사 의뢰");

    const lotGone = fake([[result(3n, 30n)], [request(30n, 80n)], []]);
    await expect(
      lockDocumentIssueInspectionTargets(lotGone.tx, [target(3n)]),
    ).rejects.toThrow("LOT");
  });
});

function fake(resultSets: unknown[][]) {
  const sql: string[] = [];
  const values: unknown[][] = [];
  const tx = {
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      sql.push(query.strings.join("?").trim());
      values.push(query.values);
      return resultSets[sql.length - 1] ?? [];
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, sql, values };
}

function result(
  id: bigint,
  requestId: bigint,
  status = "DRAFT",
  confirmedAt: Date | null = null,
) {
  return {
    inspection_result_id: id,
    inspection_request_id: requestId,
    status_code: status,
    confirmed_at: confirmedAt,
  };
}

function request(id: bigint, lotId: bigint | null) {
  return { inspection_request_id: id, lot_id: lotId };
}

function target(id: bigint): PreparedDocumentIssueTarget {
  return {
    index: 0,
    targetTypeCode: "INSPECTION_RESULT",
    targetId: id,
    requestedLotId: null,
  };
}
