import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { DowntimeList } from "../src/maintenance/downtime/downtime-query.service";
import { DowntimeView } from "../src/maintenance/downtime/downtime-view";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I32-DOWNTIME";
const LOGIN_ID = `${PREFIX}-LOGIN`;
const PASSWORD = "I32-비가동-조회-비밀번호";
const ACTIVE_REASON = `${PREFIX}-ACTIVE`;
const INACTIVE_REASON = `${PREFIX}-INACTIVE`;
const PATH = "/api/maintenance/downtimes";
const PERIOD = { startedFrom: "2026-09-01", startedTo: "2026-09-01" };

function validator(path: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, "../contracts/equipment-05설비툴.json"),
      "utf8",
    ),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ["int64", "double"]) ajv.addFormat(format, true);
  ajv.addSchema(contract, "https://omf-mes.invalid/i32-downtime-contract");
  const pointer = path.replace(/~/g, "~0").replace(/\//g, "~1");
  return ajv.compile({
    $ref: `https://omf-mes.invalid/i32-downtime-contract#/paths/${pointer}/get/responses/200/content/application~1json/schema`,
  });
}

describe("설비 비가동 조회 I-32 P1b (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let reasonGroupId = 0n;
  let createdReasonGroup = false;
  const equipment: Record<string, bigint> = {};
  const downtimes: Record<string, bigint> = {};
  const listValidator = validator("/maintenance/downtimes");
  const detailValidator = validator("/maintenance/downtimes/{downtimeId}");

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "api");
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    const user = await prisma.app_user.create({
      data: {
        login_id: LOGIN_ID,
        user_name: "비가동 조회",
        status_code: "EMPLOYED",
      },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const login = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = login.headers["set-cookie"];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  });

  afterAll(async () => {
    try {
      if (prisma) await cleanup();
    } finally {
      if (app) await app.close();
    }
  });

  it("D01 openOnly=true는 기간 없이 열린 전건을 오래된 순으로 내고 시간대를 평가하지 않는다", async () => {
    const body = await list({
      equipmentId: Number(equipment.bad),
      openOnly: true,
    });
    expect(body.items.map((item) => item.downtimeId)).toEqual([
      Number(downtimes.badOpenOld),
      Number(downtimes.badOpenNew),
    ]);
    expect(body.items.every((item) => item.endedAt === null)).toBe(true);
  });

  it("D02 기본·false는 기간 두 칸, openOnly=true의 기간도 짝을 요구하고 역전은 400이다", async () => {
    for (const query of [
      {},
      { openOnly: false },
      { startedFrom: "2026-09-01" },
      { openOnly: true, startedTo: "2026-09-01" },
    ]) {
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query(query)
        .expect(400);
      expect(
        response.body.errors.map((error: { code: string }) => error.code),
      ).toContain("REQUIRED");
    }
    const reverse = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query({ startedFrom: "2026-09-02", startedTo: "2026-09-01" })
      .expect(400);
    expect(reverse.body.errors[0]).toMatchObject({
      field: "startedTo",
      code: "RANGE",
    });
  });

  it("D03 계약 가드가 날짜·boolean·int64 형식을 거절한다", async () => {
    for (const query of [
      { ...PERIOD, openOnly: "unknown" },
      { ...PERIOD, overlappingOnly: "unknown" },
      { ...PERIOD, equipmentId: "text" },
      { startedFrom: "2026-02-30", startedTo: "2026-09-01" },
      { startedFrom: "2026-9-01", startedTo: "2026-09-01" },
      { ...PERIOD, page: "text" },
    ]) {
      await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query(query)
        .expect(400);
    }
  });

  it("D04 시작일은 설비 공장 로컬 날짜 [from,to+1)이고 서로 다른 공장은 같은 순간을 다르게 본다", async () => {
    const hanoi = await list({
      ...PERIOD,
      equipmentId: Number(equipment.hanoi),
    });
    expect(hanoi.items.map((item) => item.downtimeId)).toEqual(
      [downtimes.hanoiEndInside, downtimes.hanoiStart].map(Number),
    );
    const seoul = await list({
      ...PERIOD,
      equipmentId: Number(equipment.seoul),
    });
    expect(seoul.items.map((item) => item.downtimeId)).toEqual([
      Number(downtimes.seoulSameMoment),
    ]);
    await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query({ ...PERIOD, equipmentId: Number(equipment.bad) })
      .expect(500);
  });

  it("D05 필터·쪽·기본 내림차순과 12개 응답 필드가 계약을 만족한다", async () => {
    const body = await list({
      ...PERIOD,
      equipmentId: Number(equipment.main),
      reasonCode: ACTIVE_REASON,
      page: 2,
      size: 1,
    });
    expect(body.totalCount).toBe(3);
    expect(body.page).toEqual({ page: 2, size: 1, total: 3 });
    const item = body.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "downtimeId",
        "equipmentId",
        "equipmentCode",
        "reasonCode",
        "reasonName",
        "startedAt",
        "endedAt",
        "durationMinutes",
        "breakdownId",
        "workSessionId",
        "recordedByWorkerNo",
        "remarks",
      ].sort(),
    );
    expect(listValidator(body)).toBe(true);
  });

  it("D06 겹침은 같은 설비의 다른 원본 행을 엄격 비교하며 사유·조회기간 필터를 파트너에 전파하지 않는다", async () => {
    const body = await list({
      ...PERIOD,
      equipmentId: Number(equipment.overlap),
      reasonCode: ACTIVE_REASON,
      overlappingOnly: true,
    });
    expect(body.items.map((item) => item.downtimeId)).toEqual([
      Number(downtimes.overlapCandidate),
    ]);
    expect(body.items.map((item) => item.downtimeId)).not.toContain(
      Number(downtimes.touching),
    );
    expect(body.items.map((item) => item.downtimeId)).not.toContain(
      Number(downtimes.overlapZero),
    );
  });

  it("D07 상세는 µs·-1µs·정수/소수/열린 duration과 숫자 ETag를 보존한다", async () => {
    const exact = await detail(downtimes.exactMinute);
    expect(exact.body).toMatchObject({
      startedAt: "2026-09-01T00:00:00.123456Z",
      endedAt: "2026-09-01T00:01:00.123456Z",
      durationMinutes: 1,
      breakdownId: Number(downtimes.breakdown),
      workSessionId: null,
    });
    expect(exact.headers.etag).toBe("7");
    expect(detailValidator(exact.body)).toBe(true);
    expect(
      (await detail(downtimes.fractional)).body.durationMinutes,
    ).toBeNull();
    expect(
      (await detail(downtimes.badOpenOld)).body.durationMinutes,
    ).toBeNull();
    expect((await detail(downtimes.preEpoch)).body).toMatchObject({
      startedAt: "1969-12-31T23:59:59.999999Z",
      endedAt: "1970-01-01T00:00:59.999999Z",
      durationMinutes: 1,
    });
    expect((await detail(downtimes.yearZero)).body.startedAt).toBe(
      "0000-01-01T00:00:00.000000Z",
    );
  });

  it("D08 비활성 사유는 이름만 생략하고 필수 저장값 결손은 500이다", async () => {
    const archived = (await detail(downtimes.inactiveReason))
      .body as DowntimeView;
    expect(archived.reasonCode).toBe(INACTIVE_REASON);
    expect(archived).not.toHaveProperty("reasonName");
    await request(app.getHttpServer())
      .get(`${PATH}/${downtimes.missingReason}`)
      .set("Cookie", cookie)
      .expect(500);
    await request(app.getHttpServer())
      .get(`${PATH}/${downtimes.missingWorker}`)
      .set("Cookie", cookie)
      .expect(500);
    await request(app.getHttpServer())
      .get(`${PATH}/999999999`)
      .set("Cookie", cookie)
      .expect(404);
  });

  async function list(query: Record<string, unknown>): Promise<DowntimeList> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query(query)
      .expect(200);
    return response.body as DowntimeList;
  }

  async function detail(id: bigint): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`${PATH}/${id}`)
      .set("Cookie", cookie)
      .expect(200);
  }

  async function fixtures(): Promise<void> {
    const existingGroup = await prisma.code_group.findUnique({
      where: { group_code: "DOWNTIME_REASON" },
    });
    createdReasonGroup = existingGroup === null;
    reasonGroupId = existingGroup
      ? existingGroup.code_group_id
      : (
          await prisma.code_group.create({
            data: { group_code: "DOWNTIME_REASON", group_name: "비가동 사유" },
          })
        ).code_group_id;
    await prisma.code_value.createMany({
      data: [
        {
          code_group_id: reasonGroupId,
          code: ACTIVE_REASON,
          code_name: "금형 교체",
          is_active: true,
        },
        {
          code_group_id: reasonGroupId,
          code: INACTIVE_REASON,
          code_name: "폐기 사유",
          is_active: false,
        },
      ],
    });

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
    for (const [name, timezone] of [
      ["hanoi", "Asia/Ho_Chi_Minh"],
      ["seoul", "Asia/Seoul"],
      ["bad", "Not/A-Timezone"],
    ] as const) {
      const plant = await prisma.plant.create({
        data: {
          plant_code: `${PREFIX}-${name}`,
          plant_name: name,
          legal_entity_id: legal.legal_entity_id,
          business_unit_id: business.business_unit_id,
          timezone_code: timezone,
        },
      });
      for (const equipmentName of name === "hanoi"
        ? ["hanoi", "main", "overlap", "cross"]
        : [name]) {
        equipment[equipmentName] = (
          await prisma.equipment.create({
            data: {
              equipment_code: `${PREFIX}-${equipmentName}`,
              equipment_name: equipmentName,
              equipment_type_code: "MACHINE",
              status_code: "ACTIVE",
              plant_id: plant.plant_id,
            },
          })
        ).equipment_id;
      }
    }
    const breakdown = await prisma.breakdown.create({
      data: {
        breakdown_no: `${PREFIX}-BREAKDOWN`,
        equipment_id: equipment.main,
        reported_at: new Date("2026-09-01T00:00:00Z"),
        status_code: "RECEIVED",
        description: "비가동 상세 연결",
      },
    });
    downtimes.breakdown = breakdown.breakdown_id;

    await add(
      "hanoiBefore",
      "hanoi",
      "2026-08-31T16:59:59.999999Z",
      "2026-08-31T17:01:00Z",
    );
    await add(
      "hanoiStart",
      "hanoi",
      "2026-08-31T17:00:00Z",
      "2026-08-31T17:01:00Z",
    );
    await add("hanoiEndInside", "hanoi", "2026-09-01T16:59:59.999999Z", null);
    await add("hanoiEndExcluded", "hanoi", "2026-09-01T17:00:00Z", null);
    await add("seoulSameMoment", "seoul", "2026-08-31T16:00:00Z", null);
    await add("badOpenOld", "bad", "2026-08-01T00:00:00Z", null);
    await add("badOpenNew", "bad", "2026-09-01T00:00:00Z", null);

    await add(
      "exactMinute",
      "main",
      "2026-09-01T00:00:00.123456Z",
      "2026-09-01T00:01:00.123456Z",
      ACTIVE_REASON,
      "W-EXACT",
      7,
      breakdown.breakdown_id,
    );
    await add(
      "fractional",
      "main",
      "2026-09-01T01:00:00.123456Z",
      "2026-09-01T01:01:00.123455Z",
    );
    await add(
      "inactiveReason",
      "main",
      "2026-09-01T02:00:00Z",
      "2026-09-01T02:01:00Z",
      INACTIVE_REASON,
    );
    await add("missingReason", "main", "2026-09-01T03:00:00Z", null, null);
    await add(
      "missingWorker",
      "main",
      "2026-09-01T04:00:00Z",
      null,
      ACTIVE_REASON,
      null,
    );
    await add(
      "preEpoch",
      "main",
      "1969-12-31T23:59:59.999999Z",
      "1970-01-01T00:00:59.999999Z",
    );
    await add("yearZero", "main", "0001-01-01 00:00:00+00 BC", null);

    await add(
      "overlapOutside",
      "overlap",
      "2026-08-31T16:59:00Z",
      "2026-08-31T17:00:00.000001Z",
      INACTIVE_REASON,
    );
    await add(
      "overlapCandidate",
      "overlap",
      "2026-08-31T17:00:00Z",
      "2026-08-31T17:10:00Z",
    );
    await add(
      "touching",
      "overlap",
      "2026-08-31T17:10:00Z",
      "2026-08-31T17:11:00Z",
    );
    await add(
      "overlapZero",
      "overlap",
      "2026-08-31T17:05:00Z",
      "2026-08-31T17:05:00Z",
    );
    await add(
      "otherEquipment",
      "cross",
      "2026-08-31T17:05:00Z",
      "2026-08-31T17:06:00Z",
    );
  }

  async function add(
    name: string,
    equipmentName: string,
    startedAt: string,
    endedAt: string | null,
    reasonCode: string | null = ACTIVE_REASON,
    workerNo: string | null = "W-1",
    versionNo = 1,
    breakdownId: bigint | null = null,
  ): Promise<void> {
    const rows = await prisma.$queryRaw<{ equipment_downtime_id: bigint }[]>`
      INSERT INTO maintenance.equipment_downtime
        (equipment_id,breakdown_id,started_at,ended_at,reason_code,recorded_by_worker_no,
         remarks,version_no)
      VALUES (${equipment[equipmentName]},${breakdownId},${startedAt}::timestamptz,
        ${endedAt}::timestamptz,${reasonCode},${workerNo},${name},${versionNo})
      RETURNING equipment_downtime_id`;
    downtimes[name] = rows[0].equipment_downtime_id;
  }

  async function cleanup(): Promise<void> {
    const client = prisma ?? new PrismaClient();
    await client.equipment_downtime.deleteMany({
      where: { equipment: { equipment_code: { startsWith: `${PREFIX}-` } } },
    });
    await client.breakdown.deleteMany({
      where: { breakdown_no: `${PREFIX}-BREAKDOWN` },
    });
    await client.equipment.deleteMany({
      where: { equipment_code: { startsWith: `${PREFIX}-` } },
    });
    await client.plant.deleteMany({
      where: { plant_code: { startsWith: `${PREFIX}-` } },
    });
    await client.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await client.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
    const user = await client.app_user.findUnique({
      where: { login_id: LOGIN_ID },
    });
    if (user) {
      await client.idempotency_record.deleteMany({
        where: { app_user_id: user.app_user_id },
      });
      await client.user_credential.deleteMany({
        where: { app_user_id: user.app_user_id },
      });
      await client.app_user.delete({
        where: { app_user_id: user.app_user_id },
      });
    }
    await client.code_value.deleteMany({
      where: { code: { in: [ACTIVE_REASON, INACTIVE_REASON] } },
    });
    if (createdReasonGroup && reasonGroupId) {
      await client.code_group.deleteMany({
        where: { code_group_id: reasonGroupId, code_value: { none: {} } },
      });
    }
    if (!prisma) await (client as PrismaClient).$disconnect();
  }
});
