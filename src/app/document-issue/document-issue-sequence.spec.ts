import { Prisma } from "@prisma/client";

import { ConflictException, ContractException } from "../../common/errors";
import { PreparedDocumentIssueTarget } from "./document-issue-create-rules";
import {
  DocumentIssueTargetPathChanged,
  nextDocumentIssueSequences,
  runDocumentIssueWriteWithRetry,
} from "./document-issue-sequence";
import { targetKey } from "./document-issue-target-lookup";

describe("발행 회차와 전체 재시도 (I-27 C2d)", () => {
  it("대상을 정렬한 VALUES 한 문장으로 읽고 다음 회차를 만든다", async () => {
    const setup = fakeRows([
      { target_type_code: "LOCATION", target_id: 3n, max_issue_seq: 0 },
      { target_type_code: "LOT", target_id: 9n, max_issue_seq: 4 },
    ]);

    const result = await nextDocumentIssueSequences(
      setup.tx,
      "LOCATION_LABEL",
      [target("LOT", 9n, 1), target("LOCATION", 3n, 0)],
    );

    expect(setup.sql).toMatch(
      /WITH requested[\s\S]*LEFT JOIN app\.document_issue_log[\s\S]*GROUP BY[\s\S]*ORDER BY/,
    );
    expect(setup.values).toEqual(["LOCATION", 3n, "LOT", 9n, "LOCATION_LABEL"]);
    expect(result.get(targetKey("LOCATION", 3n))).toEqual({
      current: 0,
      next: 1,
    });
    expect(result.get(targetKey("LOT", 9n))).toEqual({
      current: 4,
      next: 5,
    });
  });

  it("회차 int 상한 뒤는 원래 ordinal의 422 RANGE다", async () => {
    const setup = fakeRows([
      {
        target_type_code: "LOT",
        target_id: 9n,
        max_issue_seq: 2_147_483_647,
      },
    ]);

    const error = await rejected(
      nextDocumentIssueSequences(setup.tx, "MATERIAL_LOT_LABEL", [
        target("LOT", 9n, 7),
      ]),
    );

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(422);
    expect((error as ContractException).errors).toEqual([
      expect.objectContaining({ field: "targets[7].targetId", code: "RANGE" }),
    ]);
  });

  it("대상이 없으면 빈 VALUES 문장을 실행하지 않는다", async () => {
    const setup = fakeRows([]);
    await expect(
      nextDocumentIssueSequences(setup.tx, "LOCATION_LABEL", []),
    ).resolves.toEqual(new Map());
    expect(setup.query).not.toHaveBeenCalled();
  });

  it("경로 변경은 실패 tx 전체를 처음부터 다시 실행한다", async () => {
    const work = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new DocumentIssueTargetPathChanged())
      .mockRejectedValueOnce(new DocumentIssueTargetPathChanged())
      .mockResolvedValue("done");

    await expect(runDocumentIssueWriteWithRetry(work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["직접 SQLSTATE", { code: "40001" }],
    ["raw query SQLSTATE", prismaError("P2010", { code: "40P01" })],
    ["Prisma transaction conflict", prismaError("P2034")],
    [
      "발행 회차 컬럼 P2002",
      prismaError("P2002", {
        target: [
          "target_id",
          "issue_seq",
          "document_type_code",
          "target_type_code",
        ],
      }),
    ],
    [
      "발행 회차 제약명 P2002",
      prismaError("P2002", { target: "uq_document_issue_log" }),
    ],
  ])("%s만 재시도한다", async (_name, retryable) => {
    const work = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue("done");

    await expect(runDocumentIssueWriteWithRetry(work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("일반 P2002와 프로그램 오류는 숨기지 않는다", async () => {
    const duplicate = prismaError("P2002", { target: ["printer_name"] });
    await expect(
      runDocumentIssueWriteWithRetry(() => Promise.reject(duplicate)),
    ).rejects.toBe(duplicate);

    const bug = new Error("bug");
    await expect(
      runDocumentIssueWriteWithRetry(() => Promise.reject(bug)),
    ).rejects.toBe(bug);
  });

  it("세 번째 실패 후에는 code 없는 409 ConflictResponse로 끝낸다", async () => {
    const work = jest.fn(() =>
      Promise.reject(new DocumentIssueTargetPathChanged()),
    );

    const error = await rejected(runDocumentIssueWriteWithRetry(work));

    expect(work).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).conflict).toEqual({
      conflictCause: "user",
      message: expect.any(String),
    });
  });
});

function fakeRows(rows: unknown[]) {
  let sql = "";
  let values: unknown[] = [];
  const query = jest.fn(async (statement: Prisma.Sql) => {
    sql = statement.strings.join("?");
    values = statement.values;
    return rows;
  });
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  return {
    tx,
    query,
    get sql() {
      return sql;
    },
    get values() {
      return values;
    },
  };
}

function target(
  targetTypeCode: PreparedDocumentIssueTarget["targetTypeCode"],
  targetId: bigint,
  index: number,
): PreparedDocumentIssueTarget {
  return { index, targetTypeCode, targetId, requestedLotId: null };
}

function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("test", {
    code,
    clientVersion: "test",
    meta,
  });
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}
