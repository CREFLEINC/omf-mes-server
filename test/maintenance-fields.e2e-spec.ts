import { Prisma, PrismaClient } from "@prisma/client";

import {
  INSPECTION_INCLUDE,
  inspectionView,
} from "../src/maintenance/inspection/inspection-view";

const PREFIX = "E2E-B-I30-FIELDS";
const WORKER_NO = `${PREFIX}-WORKER`;
const REPORTED_AT = new Date("2026-09-01T01:02:03.004Z");

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  datetime_precision: number | null;
  domain_name: string | null;
}

describe("I-30 ② A15 물리 저장 필드 (e2e)", () => {
  const prisma = new PrismaClient();
  let equipmentId: bigint;
  let workerId: bigint;
  let reporterId: bigint;
  let handlerId: bigint;

  beforeAll(async () => {
    await cleanup();
    const legal = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: PREFIX,
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    const business = await prisma.business_unit.create({
      data: {
        business_unit_code: PREFIX,
        business_unit_name: PREFIX,
        legal_entity_id: legal.legal_entity_id,
      },
    });
    const plant = await prisma.plant.create({
      data: {
        plant_code: PREFIX,
        plant_name: PREFIX,
        legal_entity_id: legal.legal_entity_id,
        business_unit_id: business.business_unit_id,
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    equipmentId = (
      await prisma.equipment.create({
        data: {
          equipment_code: PREFIX,
          equipment_name: PREFIX,
          equipment_type_code: "MACHINE",
          status_code: "ACTIVE",
          plant_id: plant.plant_id,
        },
      })
    ).equipment_id;
    workerId = (
      await prisma.worker.create({
        data: {
          worker_no: WORKER_NO,
          worker_name: PREFIX,
          business_unit_id: business.business_unit_id,
          plant_id: plant.plant_id,
          status_code: "EMPLOYED",
        },
      })
    ).worker_id;
    for (const suffix of ["REPORTER", "HANDLER"]) {
      const user = await prisma.app_user.create({
        data: { login_id: `${PREFIX}-${suffix}`, user_name: suffix },
      });
      if (suffix === "REPORTER") reporterId = user.app_user_id;
      else handlerId = user.app_user_id;
    }
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("nullable 8칸은 계약 대응 타입·길이·정밀도이며 default가 없다", async () => {
    const columns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,column_default,
             character_maximum_length,datetime_precision,domain_name
        FROM information_schema.columns
       WHERE table_schema='maintenance' AND table_name='breakdown'
         AND column_name IN ('occurrence_state_code','stopped_at','notify_assignee',
           'reporter_worker_no','cause_code','handling_note','handled_by','handled_at')`;
    expect(columns).toHaveLength(8);
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );
    for (const column of columns) {
      expect(column).toMatchObject({
        is_nullable: "YES",
        column_default: null,
      });
    }
    for (const name of ["stopped_at", "handled_at"]) {
      expect(byName[name]).toMatchObject({
        data_type: "timestamp with time zone",
        datetime_precision: 6,
      });
    }
    expect(byName.occurrence_state_code).toMatchObject({
      data_type: "character varying",
      character_maximum_length: 50,
      domain_name: "code_t",
    });
    expect(byName.reporter_worker_no).toMatchObject({
      data_type: "character varying",
      character_maximum_length: 50,
    });
    expect(byName.notify_assignee.data_type).toBe("boolean");
    expect(byName.handled_by.data_type).toBe("bigint");
    expect(byName.cause_code.data_type).toBe("text");
    expect(byName.handling_note.data_type).toBe("text");
  });

  it("과거 작성 형상은 새 8칸과 심각도를 null로 남기고 원문을 유지한다 — 091", async () => {
    // 설계 미정 — 문의 091: 필수 API 응답값을 DB default나 백필로 만들지 않는다.
    const row = await breakdown("NULL");
    expect(row).toMatchObject({
      occurrence_state_code: null,
      stopped_at: null,
      notify_assignee: null,
      reporter_worker_no: null,
      cause_code: null,
      handling_note: null,
      handled_by: null,
      handled_at: null,
      severity_code: null,
      description: "현장 원문\n누유",
      root_cause: "구 원문\n의미 미정",
      reported_by: reporterId,
      reported_at: REPORTED_AT,
      status_code: "RECEIVED",
    });
  });

  it("점검 status null 저장과 조회 매핑은 저장된 PASS와 귀속 사번을 보존한다 — 091", async () => {
    const row = await prisma.equipment_inspection.create({
      data: {
        inspection_no: `${PREFIX}-NULL`,
        equipment_id: equipmentId,
        inspection_type_code: "DAILY",
        inspected_at: REPORTED_AT,
        inspected_by: workerId,
        judgment_code: "PASS",
        status_code: null,
      },
      include: INSPECTION_INCLUDE,
    });
    expect(row.status_code).toBeNull();
    expect(inspectionView(row)).toMatchObject({
      overallResultCode: "PASS",
      inspectorWorkerNo: WORKER_NO,
      inspectedAt: REPORTED_AT.toISOString(),
    });
  });

  it("새 필드 왕복·명시 null 해제가 기존 심각도·보고·원문·처리 시각을 바꾸지 않는다", async () => {
    const startedAt = new Date("2026-09-01T02:00:00Z");
    const completedAt = new Date("2026-09-01T03:00:00Z");
    const original = await breakdown("ROUNDTRIP", {
      severity_code: "LEGACY",
      started_at: startedAt,
      completed_at: completedAt,
    });
    const where = { breakdown_id: original.breakdown_id };
    const updated = await prisma.breakdown.update({
      where,
      data: {
        occurrence_state_code: "ABNORMAL",
        stopped_at: REPORTED_AT,
        notify_assignee: false,
        reporter_worker_no: WORKER_NO,
        handling_note: "사무 처리\n원문",
        handled_by: handlerId,
        handled_at: completedAt,
      },
    });
    expect(updated).toMatchObject({
      occurrence_state_code: "ABNORMAL",
      stopped_at: REPORTED_AT,
      notify_assignee: false,
      reporter_worker_no: WORKER_NO,
      handling_note: "사무 처리\n원문",
      handled_by: handlerId,
      handled_at: completedAt,
    });
    const cleared = await prisma.breakdown.update({
      where,
      data: {
        occurrence_state_code: null,
        stopped_at: null,
        notify_assignee: null,
        reporter_worker_no: null,
        cause_code: null,
        handling_note: null,
        handled_by: null,
        handled_at: null,
      },
    });
    expect(cleared).toEqual(original);
  });

  it("보고 계정·처리 계정 관계가 분리되고 계정 없는 workerNo는 별도 문자열이다", async () => {
    const row = await breakdown("IDENTITY", {
      handled_by: handlerId,
      reporter_worker_no: WORKER_NO,
    });
    const related = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: row.breakdown_id },
      include: { app_user: true, handler: true },
    });
    expect(related.app_user?.app_user_id).toBe(reporterId);
    expect(related.handler?.app_user_id).toBe(handlerId);
    expect(related.reporter_worker_no).toBe(WORKER_NO);
    expect(
      (
        await prisma.worker.findUniqueOrThrow({
          where: { worker_id: workerId },
        })
      ).app_user_id,
    ).toBeNull();
    const reporter = await prisma.app_user.findUniqueOrThrow({
      where: { app_user_id: reporterId },
      include: { breakdown: true },
    });
    const handler = await prisma.app_user.findUniqueOrThrow({
      where: { app_user_id: handlerId },
      include: { breakdown_handled_by: true },
    });
    expect(reporter.breakdown.map((item) => item.breakdown_id)).toContain(
      row.breakdown_id,
    );
    expect(
      handler.breakdown_handled_by.map((item) => item.breakdown_id),
    ).toContain(row.breakdown_id);
  });

  it("handled_by는 계정 FK만 허용하고 참조 중 계정 삭제·키 변경은 NO ACTION이다", async () => {
    const row = await breakdown("FK", { handled_by: handlerId });
    await expect(
      prisma.breakdown.update({
        where: { breakdown_id: row.breakdown_id },
        data: { handled_by: -1n },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.app_user.delete({
        where: { app_user_id: handlerId },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    const constraints = await prisma.$queryRaw<
      {
        conname: string;
        definition: string;
        confdeltype: string;
        confupdtype: string;
      }[]
    >`
      SELECT conname,pg_get_constraintdef(oid) AS definition,confdeltype::text,confupdtype::text
        FROM pg_constraint WHERE conrelid='maintenance.breakdown'::regclass AND contype='f'`;
    expect(constraints).toContainEqual({
      conname: "breakdown_handled_by_fkey",
      definition:
        "FOREIGN KEY (handled_by) REFERENCES app.app_user(app_user_id)",
      confdeltype: "a",
      confupdtype: "a",
    });
    expect(constraints).toContainEqual({
      conname: "breakdown_reported_by_fkey",
      definition:
        "FOREIGN KEY (reported_by) REFERENCES app.app_user(app_user_id)",
      confdeltype: "a",
      confupdtype: "a",
    });
  });

  it("cause_code 저장 자리는 품질 마스터 FK와 연결되지 않는다 — 090", async () => {
    // 설계 미정 — 문의 090: 물리 저장자리 검증이며 API 비null 쓰기 허용 근거가 아니다.
    const cause = `${PREFIX}-UNRESOLVED-원문`;
    const before = await prisma.cause_code.count();
    const row = await breakdown("CAUSE", { cause_code: cause });
    expect(row.cause_code).toBe(cause);
    expect(row.root_cause).toBe("구 원문\n의미 미정");
    expect(await prisma.cause_code.count()).toBe(before);
  });

  async function breakdown(
    suffix: string,
    extra: Partial<Prisma.breakdownUncheckedCreateInput> = {},
  ): Promise<Prisma.breakdownGetPayload<object>> {
    return prisma.breakdown.create({
      data: {
        breakdown_no: `${PREFIX}-${suffix}`,
        equipment_id: equipmentId,
        reported_at: REPORTED_AT,
        reported_by: reporterId,
        description: "현장 원문\n누유",
        root_cause: "구 원문\n의미 미정",
        status_code: "RECEIVED",
        ...extra,
      },
    });
  }

  async function cleanup(): Promise<void> {
    await prisma.breakdown.deleteMany({
      where: { breakdown_no: { startsWith: PREFIX } },
    });
    await prisma.equipment_inspection.deleteMany({
      where: { inspection_no: { startsWith: PREFIX } },
    });
    await prisma.worker.deleteMany({ where: { worker_no: WORKER_NO } });
    await prisma.equipment.deleteMany({ where: { equipment_code: PREFIX } });
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
