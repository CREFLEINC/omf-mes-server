import { Prisma } from "@prisma/client";

import { DocumentIssueTargetFacts } from "./document-issue-create-rules";
import { assertDocumentIssueTerminalPermission } from "./document-issue-terminal-permission";

describe("발행 생산 단말 권한 (I-27 C3a)", () => {
  it("관리웹과 생산 외 출력물에는 기능 구성을 확대 적용하지 않는다", async () => {
    const setup = fake([]);
    await assertDocumentIssueTerminalPermission(
      setup.tx,
      "PRODUCTION_LOT_LABEL",
      null,
      [lot(1n, 10n)],
    );
    await assertDocumentIssueTerminalPermission(
      setup.tx,
      "MATERIAL_LOT_LABEL",
      7n,
      [lot(1n, 10n)],
    );
    expect(setup.query).not.toHaveBeenCalled();
  });

  it("생산 LOT의 실제 W/O 공정별 can_print_label을 한 번 검사한다", async () => {
    const setup = fake([
      { work_order_id: 10n, can_print_label: true },
      { work_order_id: 20n, can_print_label: true },
    ]);

    await expect(
      assertDocumentIssueTerminalPermission(
        setup.tx,
        "PRODUCTION_LOT_LABEL",
        7n,
        [lot(3n, 20n), lot(1n, 10n), lot(2n, 20n)],
      ),
    ).resolves.toBeUndefined();
    expect(setup.sql).toMatch(
      /production\.work_order[\s\S]*planning\.routing_operation[\s\S]*mdm\.terminal_process[\s\S]*process_id/,
    );
    expect(setup.values).toEqual([7n, 10n, 20n]);
  });

  it("권한 false·행 누락·WORK_ORDER 아닌 원천은 403이다", async () => {
    for (const [rows, facts] of [
      [[{ work_order_id: 10n, can_print_label: false }], [lot(1n, 10n)]],
      [[], [lot(1n, 10n)]],
      [[], [lot(1n, undefined, "INBOUND_RECEIPT_LINE")]],
    ] as const) {
      await expect(
        assertDocumentIssueTerminalPermission(
          fake([...rows]).tx,
          "PRODUCTION_LOT_LABEL",
          7n,
          [...facts],
        ),
      ).rejects.toMatchObject({
        status: 403,
        errors: [expect.objectContaining({ code: "PERMISSION_DENIED" })],
      });
    }
  });

  it("없는 대상 facts는 권한을 지어내지 않고 후속 미존재 판정에 맡긴다", async () => {
    const setup = fake([]);
    await expect(
      assertDocumentIssueTerminalPermission(
        setup.tx,
        "PRODUCTION_LOT_LABEL",
        7n,
        [],
      ),
    ).resolves.toBeUndefined();
    expect(setup.query).not.toHaveBeenCalled();
  });
});

function fake(rows: unknown[]) {
  let sql = "";
  let values: unknown[] = [];
  const query = jest.fn(async (statement: Prisma.Sql) => {
    sql = statement.strings.join("?");
    values = statement.values;
    return rows;
  });
  return {
    tx: { $queryRaw: query } as unknown as Prisma.TransactionClient,
    query,
    get sql() {
      return sql;
    },
    get values() {
      return values;
    },
  };
}

function lot(
  targetId: bigint,
  sourceId: bigint | undefined,
  sourceTypeCode = "WORK_ORDER",
): Extract<DocumentIssueTargetFacts, { targetTypeCode: "LOT" }> {
  return {
    targetTypeCode: "LOT",
    targetId,
    lotTypeCode: "PRODUCTION",
    statusCode: "NORMAL",
    completedAt: new Date(),
    sourceTypeCode,
    sourceId,
  };
}
