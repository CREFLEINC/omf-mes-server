import { PrismaClient } from "@prisma/client";

const PREFIX = "E2E-B-I27-A9";
const REPORTED_AT = new Date("2026-09-08T01:02:03.123Z");

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  datetime_precision: number | null;
}

interface ForeignKey {
  name: string;
  definition: string;
  on_delete: string;
  on_update: string;
}

describe("I-27 A9 발행 결과·귀속 물리 계약 (e2e)", () => {
  const prisma = new PrismaClient();
  let businessUnitId: bigint;
  let plantId: bigint;
  let issuerId: bigint;
  let reporterId: bigint;
  let issuerWorkerId: bigint;
  let reporterWorkerId: bigint;
  let targetId = 1n;

  beforeAll(async () => {
    await cleanup();
    const legalEntity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: PREFIX,
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    businessUnitId = (
      await prisma.business_unit.create({
        data: {
          business_unit_code: PREFIX,
          business_unit_name: PREFIX,
          legal_entity_id: legalEntity.legal_entity_id,
        },
      })
    ).business_unit_id;
    plantId = (
      await prisma.plant.create({
        data: {
          plant_code: PREFIX,
          plant_name: PREFIX,
          legal_entity_id: legalEntity.legal_entity_id,
          business_unit_id: businessUnitId,
          timezone_code: "Asia/Ho_Chi_Minh",
        },
      })
    ).plant_id;
    issuerId = (
      await prisma.app_user.create({
        data: { login_id: `${PREFIX}-ISSUER`, user_name: "발행 계정" },
      })
    ).app_user_id;
    reporterId = (
      await prisma.app_user.create({
        data: { login_id: `${PREFIX}-REPORTER`, user_name: "보고 계정" },
      })
    ).app_user_id;
    issuerWorkerId = (
      await prisma.worker.create({
        data: {
          worker_no: `${PREFIX}-ISSUER`,
          worker_name: "발행 작업자",
          business_unit_id: businessUnitId,
          plant_id: plantId,
          app_user_id: issuerId,
          status_code: "EMPLOYED",
        },
      })
    ).worker_id;
    reporterWorkerId = (
      await prisma.worker.create({
        data: {
          worker_no: `${PREFIX}-REPORTER`,
          worker_name: "보고 작업자",
          business_unit_id: businessUnitId,
          plant_id: plantId,
          app_user_id: reporterId,
          status_code: "EMPLOYED",
        },
      })
    ).worker_id;
  });

  afterAll(async () => {
    try {
      await cleanup();
      const remaining = await Promise.all([
        prisma.document_issue_log.count({
          where: { remarks: { startsWith: PREFIX } },
        }),
        prisma.worker.count({ where: { worker_no: { startsWith: PREFIX } } }),
        prisma.app_user.count({ where: { login_id: { startsWith: PREFIX } } }),
        prisma.plant.count({ where: { plant_code: PREFIX } }),
        prisma.business_unit.count({ where: { business_unit_code: PREFIX } }),
        prisma.legal_entity.count({ where: { legal_entity_code: PREFIX } }),
      ]);
      expect(remaining).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("S01 nullable 여섯 칸의 타입·길이·정밀도에 default가 없다", async () => {
    const columns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,column_default,
             character_maximum_length,datetime_precision
      FROM information_schema.columns
      WHERE table_schema='app' AND table_name='document_issue_log'`;
    expect(columns).toHaveLength(18);
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );
    expect(byName.print_outcome_code).toMatchObject({
      data_type: "character varying",
      is_nullable: "YES",
      column_default: null,
      character_maximum_length: 40,
    });
    expect(byName.print_failure_reason).toMatchObject({
      data_type: "character varying",
      is_nullable: "YES",
      column_default: null,
      character_maximum_length: 500,
    });
    expect(byName.print_reported_at).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      column_default: null,
      datetime_precision: 6,
    });
    for (const name of [
      "issued_worker_id",
      "print_reported_worker_id",
      "print_reported_by",
    ]) {
      expect(byName[name]).toMatchObject({
        data_type: "bigint",
        is_nullable: "YES",
        column_default: null,
      });
    }
  });

  it("S02 기존 writer 형상은 결과·귀속 여섯 칸을 전부 null로 보존한다", async () => {
    const row = await createIssue();
    expect(row).toMatchObject({
      print_outcome_code: null,
      print_failure_reason: null,
      print_reported_at: null,
      issued_worker_id: null,
      print_reported_worker_id: null,
      print_reported_by: null,
    });
  });

  it("S03 결과 enum은 null·PENDING·SUCCEEDED·FAILED만 허용한다", async () => {
    const pending = await createIssue({ print_outcome_code: "PENDING" });
    expect(pending.print_outcome_code).toBe("PENDING");
    const succeeded = await createReportedIssue("SUCCEEDED");
    expect(succeeded.print_outcome_code).toBe("SUCCEEDED");
    const failed = await createReportedIssue("FAILED", "용지 걸림");
    expect(failed.print_outcome_code).toBe("FAILED");

    const invalid = await createIssue();
    await expect(
      prisma.document_issue_log.update({
        where: { document_issue_log_id: invalid.document_issue_log_id },
        data: { print_outcome_code: "UNKNOWN" },
      }),
    ).rejects.toThrow("ck_document_issue_print_outcome");
  });

  it("S04 null·PENDING 결과에 보고 정보가 섞이면 전부 거부된다", async () => {
    const invalidData = [
      { print_reported_at: REPORTED_AT },
      { print_failure_reason: "오류" },
      { print_reported_worker_id: reporterWorkerId },
      { print_reported_by: reporterId },
    ];
    for (const printOutcomeCode of [null, "PENDING"] as const) {
      for (const data of invalidData) {
        const row = await createIssue({ print_outcome_code: printOutcomeCode });
        await expect(
          prisma.document_issue_log.update({
            where: { document_issue_log_id: row.document_issue_log_id },
            data,
          }),
        ).rejects.toThrow("ck_document_issue_print_report");
      }
    }
  });

  it("S05 성공 보고는 시각·보고 계정·보고 작업자가 모두 필요하고 사유는 거부된다", async () => {
    for (const data of [
      {
        print_reported_worker_id: reporterWorkerId,
        print_reported_by: reporterId,
      },
      { print_reported_at: REPORTED_AT, print_reported_by: reporterId },
      {
        print_reported_at: REPORTED_AT,
        print_reported_worker_id: reporterWorkerId,
      },
    ]) {
      const row = await createIssue({ print_outcome_code: "PENDING" });
      await expect(
        prisma.document_issue_log.update({
          where: { document_issue_log_id: row.document_issue_log_id },
          data: { ...data, print_outcome_code: "SUCCEEDED" },
        }),
      ).rejects.toThrow("ck_document_issue_print_report");
    }
    const row = await createIssue({ print_outcome_code: "PENDING" });
    await expect(
      prisma.document_issue_log.update({
        where: { document_issue_log_id: row.document_issue_log_id },
        data: {
          print_outcome_code: "SUCCEEDED",
          print_reported_at: REPORTED_AT,
          print_reported_worker_id: reporterWorkerId,
          print_reported_by: reporterId,
          print_failure_reason: "성공인데 사유가 있음",
        },
      }),
    ).rejects.toThrow("ck_document_issue_print_report");
  });

  it("S06 실패 보고는 빈문자열·일반공백을 거부하되 DB 검사를 API whitespace로 확대하지 않는다", async () => {
    for (const reason of [null, "", "   "]) {
      const row = await createIssue({ print_outcome_code: "PENDING" });
      await expect(
        prisma.document_issue_log.update({
          where: { document_issue_log_id: row.document_issue_log_id },
          data: reportData("FAILED", reason),
        }),
      ).rejects.toThrow("ck_document_issue_print_report");
    }

    for (const data of [
      {
        print_failure_reason: "용지 걸림",
        print_reported_worker_id: reporterWorkerId,
        print_reported_by: reporterId,
      },
      {
        print_failure_reason: "용지 걸림",
        print_reported_at: REPORTED_AT,
        print_reported_by: reporterId,
      },
      {
        print_failure_reason: "용지 걸림",
        print_reported_at: REPORTED_AT,
        print_reported_worker_id: reporterWorkerId,
      },
    ]) {
      const row = await createIssue({ print_outcome_code: "PENDING" });
      await expect(
        prisma.document_issue_log.update({
          where: { document_issue_log_id: row.document_issue_log_id },
          data: { ...data, print_outcome_code: "FAILED" },
        }),
      ).rejects.toThrow("ck_document_issue_print_report");
    }

    // DB btrim은 일반공백 최소 제약이다. 탭/개행까지의 거부는 report API가 맡는다.
    const tabReason = await createIssue({ print_outcome_code: "PENDING" });
    const updated = await prisma.document_issue_log.update({
      where: { document_issue_log_id: tabReason.document_issue_log_id },
      data: reportData("FAILED", "\t"),
    });
    expect(updated.print_failure_reason).toBe("\t");
  });

  it("S07 발행 작업자와 보고 작업자·계정은 서로 다른 FK로 원문을 보존한다", async () => {
    const row = await createIssue({
      print_outcome_code: "SUCCEEDED",
      print_reported_at: REPORTED_AT,
      issued_worker_id: issuerWorkerId,
      print_reported_worker_id: reporterWorkerId,
      print_reported_by: reporterId,
    });
    expect(row).toMatchObject({
      issued_by: issuerId,
      issued_worker_id: issuerWorkerId,
      print_reported_worker_id: reporterWorkerId,
      print_reported_by: reporterId,
    });

    for (const deletion of [
      () => prisma.worker.delete({ where: { worker_id: issuerWorkerId } }),
      () => prisma.worker.delete({ where: { worker_id: reporterWorkerId } }),
      () => prisma.app_user.delete({ where: { app_user_id: reporterId } }),
    ]) {
      await expect(deletion()).rejects.toMatchObject({ code: "P2003" });
    }
  });

  it("S08 신규 FK 셋은 Prisma 기본 이름과 양방향 NO ACTION을 사용한다", async () => {
    const constraints = await prisma.$queryRaw<ForeignKey[]>`
      SELECT conname AS name,pg_get_constraintdef(oid) AS definition,
             confdeltype::text AS on_delete,confupdtype::text AS on_update
      FROM pg_constraint
      WHERE conrelid='app.document_issue_log'::regclass
        AND conname IN (
          'document_issue_log_issued_worker_id_fkey',
          'document_issue_log_print_reported_worker_id_fkey',
          'document_issue_log_print_reported_by_fkey'
        )
      ORDER BY conname`;
    expect(constraints).toEqual([
      {
        name: "document_issue_log_issued_worker_id_fkey",
        definition:
          "FOREIGN KEY (issued_worker_id) REFERENCES mdm.worker(worker_id)",
        on_delete: "a",
        on_update: "a",
      },
      {
        name: "document_issue_log_print_reported_by_fkey",
        definition:
          "FOREIGN KEY (print_reported_by) REFERENCES app.app_user(app_user_id)",
        on_delete: "a",
        on_update: "a",
      },
      {
        name: "document_issue_log_print_reported_worker_id_fkey",
        definition:
          "FOREIGN KEY (print_reported_worker_id) REFERENCES mdm.worker(worker_id)",
        on_delete: "a",
        on_update: "a",
      },
    ]);
  });

  it("S09 여섯 칸의 주석은 결과 미확인·서버 접수·분리 귀속을 명시한다", async () => {
    const comments = await prisma.$queryRaw<
      { name: string; description: string }[]
    >`
      SELECT a.attname AS name,col_description(a.attrelid,a.attnum) AS description
      FROM pg_attribute a
      WHERE a.attrelid='app.document_issue_log'::regclass
        AND a.attname IN (
          'print_outcome_code','print_failure_reason','print_reported_at',
          'issued_worker_id','print_reported_worker_id','print_reported_by'
        )`;
    expect(
      Object.fromEntries(comments.map((row) => [row.name, row.description])),
    ).toEqual({
      print_outcome_code:
        "인쇄 결과. 신규 발행만 명시 PENDING; NULL은 과거 결과 미확인이고 PENDING으로 간주하지 않는다.",
      print_reported_at:
        "인쇄 결과를 서버가 접수한 시각. 실물 인쇄 발생시각을 도출하지 않는다.",
      print_failure_reason: "FAILED 결과의 필수 실패 사유. 성공 결과에는 NULL.",
      issued_worker_id:
        "X-Worker-No로 확인한 최초 발행 귀속 작업자. issued_by 계정FK와 별개.",
      print_reported_worker_id:
        "결과 보고 X-Worker-No 귀속 작업자. 최초 발행 사번을 덮지 않는다.",
      print_reported_by:
        "인쇄 결과를 보고한 인증 계정. issued_by 최초 발행 계정과 별개.",
    });
  });

  async function createIssue(
    data: Partial<{
      print_outcome_code: string | null;
      print_failure_reason: string | null;
      print_reported_at: Date | null;
      issued_worker_id: bigint | null;
      print_reported_worker_id: bigint | null;
      print_reported_by: bigint | null;
    }> = {},
  ) {
    targetId += 1n;
    return prisma.document_issue_log.create({
      data: {
        document_type_code: "LOCATION_LABEL",
        target_type_code: "LOCATION",
        target_id: targetId,
        issued_by: issuerId,
        remarks: `${PREFIX}-${targetId}`,
        ...data,
      },
    });
  }

  async function createReportedIssue(
    outcome: "SUCCEEDED" | "FAILED",
    reason: string | null = null,
  ) {
    return createIssue(reportData(outcome, reason));
  }

  function reportData(outcome: "SUCCEEDED" | "FAILED", reason: string | null) {
    return {
      print_outcome_code: outcome,
      print_failure_reason: reason,
      print_reported_at: REPORTED_AT,
      print_reported_worker_id: reporterWorkerId,
      print_reported_by: reporterId,
    };
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    await prisma.document_issue_log.deleteMany({
      where: {
        OR: [
          { remarks: { startsWith: PREFIX } },
          { issued_by: { in: userIds } },
          { print_reported_by: { in: userIds } },
        ],
      },
    });
    await prisma.worker.deleteMany({
      where: { worker_no: { startsWith: PREFIX } },
    });
    await prisma.app_user.deleteMany({
      where: { login_id: { startsWith: PREFIX } },
    });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
  }
});
