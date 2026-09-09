import { Prisma } from "@prisma/client";

import { DocumentIssueCreateInput } from "./document-issue-create-rules";
import { DocumentIssueWriteService } from "./document-issue-write.service";
import { DocumentIssueWriteContext } from "./document-issue-write-context";

describe("발행 배치 작성 (I-27 C3b)", () => {
  const service = new DocumentIssueWriteService();

  it("신규·재발행을 한 batch로 쓰고 반환 순서와 사유를 원본에 맞춘다", async () => {
    const setup = fake({
      sequences: [sequence(10n, 1), sequence(20n, 0)],
      reasonActive: true,
    });

    const result = await service.issueWithin(
      setup.tx,
      input([20, 10], "DAMAGED"),
      context(),
    );

    expect(setup.created).toHaveLength(2);
    expect(setup.created[0]).toMatchObject({
      target_id: 20n,
      issue_seq: 1,
      reissue_reason_code: null,
      issued_by: 17n,
      issued_worker_id: null,
      print_outcome_code: "PENDING",
      print_reported_at: null,
    });
    expect(setup.created[1]).toMatchObject({
      target_id: 10n,
      issue_seq: 2,
      reissue_reason_code: "DAMAGED",
    });
    expect(result.issuedCount).toBe(2);
    expect(result.items.map((item) => item.target.targetId)).toEqual([20, 10]);
    expect(result.items.map((item) => item.reissueReasonName)).toEqual([
      null,
      "Damaged",
    ]);
  });

  it("제공한 사번은 실제 worker FK로 저장한다", async () => {
    const setup = fake({ sequences: [sequence(10n, 0)], workerId: 77n });

    await service.issueWithin(
      setup.tx,
      input([10]),
      context({ workerNo: "W-077" }),
    );

    expect(setup.workerWhere).toEqual({ worker_no: "W-077" });
    expect(setup.created[0]).toMatchObject({ issued_worker_id: 77n });
  });

  it("없는 사번과 비활성 재발행 사유는 쓰기 전에 전건 거절한다", async () => {
    const noWorker = fake({ sequences: [sequence(10n, 0)] });
    await expect(
      service.issueWithin(
        noWorker.tx,
        input([10]),
        context({ workerNo: "UNKNOWN" }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        expect.objectContaining({ field: "X-Worker-No", code: "INVALID" }),
      ],
    });
    expect(noWorker.created).toEqual([]);

    const badReason = fake({ sequences: [sequence(10n, 1)] });
    await expect(
      service.issueWithin(badReason.tx, input([10], "DISABLED"), context()),
    ).rejects.toMatchObject({
      status: 422,
      errors: [
        expect.objectContaining({
          field: "reissueReasonCode",
          code: "INVALID",
        }),
      ],
    });
    expect(badReason.created).toEqual([]);
  });

  it("미존재 대상은 로그를 만들지 않고 422다", async () => {
    const setup = fake({
      sequences: [sequence(10n, 0)],
      missingLocations: true,
    });

    await expect(
      service.issueWithin(setup.tx, input([10]), context()),
    ).rejects.toMatchObject({
      status: 422,
      errors: [
        expect.objectContaining({
          field: "targets[0].targetId",
          code: "INVALID",
        }),
      ],
    });
    expect(setup.created).toEqual([]);
  });

  it("성적서는 선제 차단하지 않고 조율된 검사 결과 잠금으로 진입한다", async () => {
    const setup = fake({ sequences: [] });
    const coa: DocumentIssueCreateInput = {
      documentTypeCode: "CERTIFICATE_OF_ANALYSIS",
      targets: [{ targetTypeCode: "INSPECTION_RESULT", targetId: 10 }],
    };

    await expect(
      service.issueWithin(setup.tx, coa, context()),
    ).rejects.toMatchObject({
      status: 422,
      errors: [
        expect.objectContaining({
          field: "targets[0].targetId",
          code: "INVALID",
        }),
      ],
    });
    expect(setup.rawQueries).toEqual([
      expect.stringMatching(/FROM quality\.inspection_result[\s\S]*FOR SHARE/),
      expect.stringMatching(/WITH requested/),
    ]);
  });
});

interface FakeOptions {
  missingLocations?: boolean;
  reasonActive?: boolean;
  sequences: Array<{
    target_type_code: string;
    target_id: bigint;
    max_issue_seq: number;
  }>;
  workerId?: bigint;
}

function fake(options: FakeOptions) {
  const rawQueries: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  let workerWhere: unknown;
  let ids = 100n;
  const queryRaw = jest.fn(async (statement: Prisma.Sql) => {
    const sql = statement.strings.join("?");
    rawQueries.push(sql);
    if (sql.includes("FROM mdm.location")) {
      if (options.missingLocations) return [];
      return statement.values.map((value) => ({ target_id: value }));
    }
    if (sql.includes("WITH requested")) return options.sequences;
    return [];
  });
  const tx = {
    $queryRaw: queryRaw,
    worker: {
      findUnique: jest.fn(async ({ where }) => {
        workerWhere = where;
        return options.workerId === undefined
          ? null
          : { worker_id: options.workerId };
      }),
    },
    code_value: {
      findFirst: jest.fn(async () =>
        options.reasonActive ? { code_value_id: 1n } : null,
      ),
      findMany: jest.fn(async () => [
        { code: "DAMAGED", code_name: "Damaged" },
      ]),
    },
    document_issue_log: {
      createManyAndReturn: jest.fn(async ({ data }) => {
        created.push(...data);
        return [...data]
          .map((row) => ({
            document_issue_log_id: ids++,
            document_type_code: row.document_type_code,
            target_type_code: row.target_type_code,
            target_id: row.target_id,
            issue_seq: row.issue_seq,
          }))
          .reverse();
      }),
      findMany: jest.fn(async () =>
        [...created].reverse().map((row, index) => ({
          ...row,
          document_issue_log_id: 100n + BigInt(created.length - index - 1),
          app_user: { user_name: "Actor" },
          lot: null,
        })),
      ),
    },
    lot: { findMany: jest.fn(async () => []) },
    serial_number: { findMany: jest.fn(async () => []) },
    handling_unit: { findMany: jest.fn(async () => []) },
    goods_issue_line: { findMany: jest.fn(async () => []) },
    mold: { findMany: jest.fn(async () => []) },
    location: {
      findMany: jest.fn(async ({ where }) =>
        where.location_id.in.map((location_id: bigint) => ({
          location_id,
          location_name: `Location ${location_id}`,
        })),
      ),
    },
    inspection_result: { findMany: jest.fn(async () => []) },
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    created,
    rawQueries,
    get workerWhere() {
      return workerWhere;
    },
  };
}

function input(ids: number[], reason?: string): DocumentIssueCreateInput {
  return {
    documentTypeCode: "LOCATION_LABEL",
    targets: ids.map((targetId) => ({ targetTypeCode: "LOCATION", targetId })),
    reissueReasonCode: reason,
    printerName: "printer-a",
    remarks: "test",
  };
}

function sequence(targetId: bigint, max_issue_seq: number) {
  return { target_type_code: "LOCATION", target_id: targetId, max_issue_seq };
}

function context(
  override: Partial<DocumentIssueWriteContext> = {},
): DocumentIssueWriteContext {
  return {
    key: "idem-1",
    fingerprint: "fingerprint",
    successStatus: 201,
    appUserId: 17,
    terminalId: null,
    ...override,
  };
}
