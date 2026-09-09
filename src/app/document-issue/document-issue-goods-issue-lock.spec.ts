import { Prisma } from "@prisma/client";

import { PreparedDocumentIssueTarget } from "./document-issue-create-rules";
import {
  DocumentIssueGoodsIssuePathChanged,
  lockDocumentIssueGoodsIssueTargets,
} from "./document-issue-goods-issue-lock";
import { targetKey } from "./document-issue-target-lookup";

describe("발행 출고 라인 교차 잠금 (I-27 C2b)", () => {
  it("헤더와 LOT을 ID 순서로 잠근 뒤 확정 경로의 사실을 반환한다", async () => {
    const setup = fake([
      [line(3n, 10n, 70n), line(5n, 30n, 80n), line(9n, 30n, 90n)],
      [header(10n, "POSTED"), header(30n, "POSTED")],
      [line(3n, 10n, 70n), line(5n, 30n, 80n), line(9n, 30n, 90n)],
      [{ lot_id: 70n }, { lot_id: 80n }, { lot_id: 90n }],
    ]);

    const facts = await lockDocumentIssueGoodsIssueTargets(setup.tx, [
      target(9n),
      target(3n),
      target(5n),
    ]);

    expect(setup.sql).toEqual([
      expect.stringMatching(
        /goods_issue_line[\s\S]*ORDER BY goods_issue_line_id$/,
      ),
      expect.stringMatching(
        /FROM logistics\.goods_issue[\s\S]*ORDER BY goods_issue_id FOR NO KEY UPDATE/,
      ),
      expect.stringMatching(
        /goods_issue_line[\s\S]*ORDER BY goods_issue_line_id$/,
      ),
      expect.stringMatching(
        /FROM trace\.lot[\s\S]*ORDER BY lot_id FOR NO KEY UPDATE/,
      ),
    ]);
    expect(setup.values).toEqual([
      [3n, 5n, 9n],
      [10n, 30n],
      [3n, 5n, 9n],
      [70n, 80n, 90n],
    ]);
    expect(facts.get(targetKey("GOODS_ISSUE_LINE", 5n))).toEqual({
      targetTypeCode: "GOODS_ISSUE_LINE",
      targetId: 5n,
      lotId: 80n,
      goodsIssueStatusCode: "POSTED",
    });
  });

  it("잠금 뒤 라인의 헤더 경로가 바뀌면 전체 재시도 신호를 낸다", async () => {
    const setup = fake([
      [line(3n, 10n, 70n)],
      [header(10n, "POSTED")],
      [line(3n, 11n, 70n)],
    ]);

    await expect(
      lockDocumentIssueGoodsIssueTargets(setup.tx, [target(3n)]),
    ).rejects.toBeInstanceOf(DocumentIssueGoodsIssuePathChanged);
    expect(setup.sql).toHaveLength(3);
  });

  it("잠금 뒤 라인이 사라지거나 LOT이 바뀌어도 전체 재시도한다", async () => {
    const deleted = fake([[line(3n, 10n, 70n)], [header(10n, "POSTED")], []]);
    await expect(
      lockDocumentIssueGoodsIssueTargets(deleted.tx, [target(3n)]),
    ).rejects.toBeInstanceOf(DocumentIssueGoodsIssuePathChanged);

    const moved = fake([
      [line(3n, 10n, 70n)],
      [header(10n, "POSTED")],
      [line(3n, 10n, 71n)],
    ]);
    await expect(
      lockDocumentIssueGoodsIssueTargets(moved.tx, [target(3n)]),
    ).rejects.toBeInstanceOf(DocumentIssueGoodsIssuePathChanged);
  });

  it("후보 헤더나 확정 LOT이 사라지면 전체 재시도한다", async () => {
    const headerGone = fake([[line(3n, 10n, 70n)], []]);
    await expect(
      lockDocumentIssueGoodsIssueTargets(headerGone.tx, [target(3n)]),
    ).rejects.toBeInstanceOf(DocumentIssueGoodsIssuePathChanged);

    const lotGone = fake([
      [line(3n, 10n, 70n)],
      [header(10n, "POSTED")],
      [line(3n, 10n, 70n)],
      [],
    ]);
    await expect(
      lockDocumentIssueGoodsIssueTargets(lotGone.tx, [target(3n)]),
    ).rejects.toBeInstanceOf(DocumentIssueGoodsIssuePathChanged);
  });

  it("최초 조회부터 없는 라인은 재시도하지 않고 미존재 사실로 남긴다", async () => {
    const setup = fake([[]]);

    await expect(
      lockDocumentIssueGoodsIssueTargets(setup.tx, [target(404n)]),
    ).resolves.toEqual(new Map());
    expect(setup.sql).toHaveLength(1);
  });

  it("출고 라인이 없으면 빈 IN 문장을 실행하지 않는다", async () => {
    const setup = fake([]);

    await expect(
      lockDocumentIssueGoodsIssueTargets(setup.tx, []),
    ).resolves.toEqual(new Map());
    expect(setup.sql).toEqual([]);
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

function line(id: bigint, headerId: bigint, lotId: bigint) {
  return {
    goods_issue_line_id: id,
    goods_issue_id: headerId,
    lot_id: lotId,
  };
}

function header(id: bigint, status: string) {
  return { goods_issue_id: id, status_code: status };
}

function target(id: bigint): PreparedDocumentIssueTarget {
  return {
    index: 0,
    targetTypeCode: "GOODS_ISSUE_LINE",
    targetId: id,
    requestedLotId: null,
  };
}
