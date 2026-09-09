import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import type {
  DowntimeCreate,
  DowntimeUpdate,
} from "../src/maintenance/downtime/downtime-rules";
import { DowntimeList } from "../src/maintenance/downtime/downtime-query.service";
import { DowntimeView } from "../src/maintenance/downtime/downtime-view";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I32-DOWNTIME";
const LOGIN_ID = `${PREFIX}-LOGIN`;
const OTHER_LOGIN_ID = `${PREFIX}-OTHER`;
const NO_PERMISSION_LOGIN_ID = `${PREFIX}-NO-PERMISSION`;
const ROLE = `${PREFIX}-ROLE`;
const PASSWORD = "I32-비가동-조회-비밀번호";
const ACTIVE_REASON = `${PREFIX}-ACTIVE`;
const UPDATED_REASON = `${PREFIX}-UPDATED`;
const INACTIVE_REASON = `${PREFIX}-INACTIVE`;
const WORKER_NO = `${PREFIX}-WORKER`;
const OTHER_WORKER_NO = `${PREFIX}-OTHER-WORKER`;
const PATH = "/api/maintenance/downtimes";
const PERIOD = { startedFrom: "2026-09-01", startedTo: "2026-09-01" };

function validator(
  path: string,
  method = "get",
  status = "200",
): ValidateFunction {
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
    $ref: `https://omf-mes.invalid/i32-downtime-contract#/paths/${pointer}/${method}/responses/${status}/content/application~1json/schema`,
  });
}

describe("설비 비가동 조회·쓰기 I-32 P1b/P3/P4 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let otherCookie: string[];
  let noPermissionCookie: string[];
  let actorUserId = 0n;
  let otherUserId = 0n;
  let businessUnitId = 0n;
  let hanoiPlantId = 0n;
  let reasonGroupId = 0n;
  let createdReasonGroup = false;
  const equipment: Record<string, bigint> = {};
  const downtimes: Record<string, bigint> = {};
  const breakdowns: Record<string, bigint> = {};
  const listValidator = validator("/maintenance/downtimes");
  const detailValidator = validator("/maintenance/downtimes/{downtimeId}");
  const createValidator = validator("/maintenance/downtimes", "post", "201");
  const updateValidator = validator(
    "/maintenance/downtimes/{downtimeId}",
    "put",
    "200",
  );
  const closeValidator = validator(
    "/maintenance/downtimes/{downtimeId}:close",
    "post",
    "200",
  );
  const summaryValidator = validator("/maintenance/downtimes/summary");

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
    const user = await createUser(LOGIN_ID, "비가동 입력");
    const other = await createUser(OTHER_LOGIN_ID, "다른 입력자");
    await createUser(NO_PERMISSION_LOGIN_ID, "권한 없음");
    actorUserId = user.app_user_id;
    otherUserId = other.app_user_id;
    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: "비가동 입력용" },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: "P-05-02" },
    });
    await prisma.user_role.createMany({
      data: [user.app_user_id, other.app_user_id].map((app_user_id) => ({
        app_user_id,
        role_id: role.role_id,
      })),
    });
    await prisma.worker.createMany({
      data: [WORKER_NO, OTHER_WORKER_NO].map((worker_no) => ({
        worker_no,
        worker_name: worker_no,
        business_unit_id: businessUnitId,
        plant_id: hanoiPlantId,
        status_code: "ACTIVE",
      })),
    });
    cookie = await login(LOGIN_ID);
    otherCookie = await login(OTHER_LOGIN_ID);
    noPermissionCookie = await login(NO_PERMISSION_LOGIN_ID);
  });

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers["set-cookie"];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function createUser(loginId: string, userName: string) {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: userName, status_code: "EMPLOYED" },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    return user;
  }

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

  it("D09 summary 기본 탭은 장비합집합·경미정지와 계약 응답을 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", cookie)
      .query({ ...PERIOD, equipmentId: Number(equipment.summary) })
      .expect(200);
    expect(summaryValidator(response.body)).toBe(true);
    expect(summaryValidator.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({
      operatingMinutes: 0,
      plannedDowntimeMinutes: 0,
      actualDowntimeMinutes: 8,
      availabilityPercent: null,
      openIntervalCount: 1,
      overlappingIntervalCount: 2,
      minorStopCount: 1,
      minorStopMinutes: 4,
      minorStopThresholdMinutes: 5,
      sessionsWithoutEquipmentCount: 0,
      correctiveMaintenanceCount: 0,
      preventiveMaintenanceCount: 0,
      breakdownsClosedWithoutOrderCount: 0,
      byReason: [
        {
          reasonCode: ACTIVE_REASON,
          reasonName: "금형 교체",
          count: 2,
          totalMinutes: 10,
          sharePercent: 125,
          averageMinutes: 5,
        },
      ],
    });
    expect(response.body).not.toHaveProperty("byEquipment");
    expect(response.body).not.toHaveProperty("byPeriod");
  });

  it("D10 summary는 요청한 EQUIPMENT·PERIOD 탭 하나만 채운다", async () => {
    const query = { ...PERIOD, equipmentId: Number(equipment.summary) };
    const byEquipment = await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", cookie)
      .query({ ...query, groupBy: "EQUIPMENT", bucket: "MONTH" })
      .expect(200);
    expect(byEquipment.body.byEquipment).toEqual([
      {
        equipmentId: Number(equipment.summary),
        equipmentCode: `${PREFIX}-summary`,
        equipmentName: "summary",
        count: 2,
        totalMinutes: 8,
        sharePercent: 100,
        averageMinutes: 4,
      },
    ]);
    expect(byEquipment.body).not.toHaveProperty("byReason");
    expect(byEquipment.body).not.toHaveProperty("byPeriod");

    const byPeriod = await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", cookie)
      .query({ ...query, groupBy: "PERIOD", bucket: "DAY" })
      .expect(200);
    expect(byPeriod.body.byPeriod).toEqual([
      { periodStart: "2026-09-01", count: 2, totalMinutes: 8 },
    ]);
    expect(byPeriod.body).not.toHaveProperty("byReason");
    expect(byPeriod.body).not.toHaveProperty("byEquipment");
  });

  it("D11 summary 계약 입력·역전·인증 경계를 지킨다", async () => {
    const valid = { ...PERIOD, equipmentId: Number(equipment.summary) };
    await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", cookie)
      .query({ startedFrom: PERIOD.startedFrom })
      .expect(400);
    await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", cookie)
      .query({ ...valid, groupBy: "UNKNOWN" })
      .expect(400);
    const reversed = await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", cookie)
      .query({ ...valid, startedFrom: "2026-09-02" })
      .expect(400);
    expect(reversed.body.errors[0]).toMatchObject({
      field: "startedTo",
      code: "RANGE",
    });
    await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .query(valid)
      .expect(401);
    await request(app.getHttpServer())
      .get(`${PATH}/summary`)
      .set("Cookie", noPermissionCookie)
      .query(valid)
      .expect(200);
  });

  it("D15 required 3칸으로 open을 만들고 사번·null·version 1을 정확히 저장한다", async () => {
    const body = createBody("writeOpen", {
      startedAt: "2026-09-08T13:00:00.123456+07:00",
    });
    const response = await postDowntime(body).expect(201);

    expect(response.body).toMatchObject({
      equipmentId: Number(equipment.writeOpen),
      reasonCode: ACTIVE_REASON,
      reasonName: "금형 교체",
      startedAt: "2026-09-08T06:00:00.123456Z",
      endedAt: null,
      durationMinutes: null,
      breakdownId: null,
      workSessionId: null,
      recordedByWorkerNo: WORKER_NO,
      remarks: null,
    });
    expect(createValidator(response.body)).toBe(true);
    // Express의 본문 캐시용 weak ETag는 있을 수 있지만 버전 토큰 "1"은 발행하지 않는다.
    expect(response.headers.etag).not.toBe("1");

    const rows = await prisma.$queryRaw<
      {
        downtime_type_code: string | null;
        recorded_by_worker_no: string | null;
        remarks: string | null;
        version_no: number;
        created_by: bigint | null;
        closed_by: bigint | null;
        started_epoch_us: string;
      }[]
    >`
      SELECT downtime_type_code,recorded_by_worker_no,remarks,version_no,
        created_by,closed_by,
        (extract(epoch FROM started_at)*1000000)::bigint::text AS started_epoch_us
      FROM maintenance.equipment_downtime
      WHERE equipment_downtime_id=${BigInt(response.body.downtimeId)}`;
    expect(rows[0]).toEqual({
      downtime_type_code: null,
      recorded_by_worker_no: WORKER_NO,
      remarks: null,
      version_no: 1,
      created_by: actorUserId,
      closed_by: null,
      started_epoch_us: "1788847200123456",
    });
  });

  it("D16 기존 open이 있어도 겹치는 과거 닫힌 구간은 허용한다", async () => {
    await postDowntime(
      createBody("writeClosed", { startedAt: "2026-09-08T00:00:00Z" }),
    ).expect(201);
    const closed = await postDowntime(
      createBody("writeClosed", {
        startedAt: "2026-09-08T00:30:00Z",
        endedAt: "2026-09-08T00:45:00Z",
        remarks: "과거 입력",
      }),
    ).expect(201);
    expect(closed.body).toMatchObject({
      endedAt: "2026-09-08T00:45:00.000000Z",
      durationMinutes: 15,
      remarks: "과거 입력",
    });
    expect(
      await prisma.equipment_downtime.findUnique({
        where: {
          equipment_downtime_id: BigInt(closed.body.downtimeId),
        },
        select: { created_by: true, closed_by: true },
      }),
    ).toEqual({ created_by: actorUserId, closed_by: actorUserId });
  });

  it("D17 같은 설비의 동시 open은 하나만 성공하고 다른 설비는 독립이다", async () => {
    const same = await Promise.all([
      postDowntime(
        createBody("writeConcurrent", {
          startedAt: "2026-09-08T01:00:00Z",
        }),
      ),
      postDowntime(
        createBody("writeConcurrent", {
          startedAt: "2026-09-08T01:01:00Z",
        }),
      ),
    ]);
    expect(same.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(
      same.find((response) => response.status === 422)?.body.errors[0],
    ).toMatchObject({ field: "equipmentId", code: "STATE_LOCKED" });
    expect(
      await prisma.equipment_downtime.count({
        where: { equipment_id: equipment.writeConcurrent, ended_at: null },
      }),
    ).toBe(1);

    const separate = await Promise.all([
      postDowntime(createBody("writeParallelA")),
      postDowntime(createBody("writeParallelB")),
    ]);
    expect(separate.map((response) => response.status)).toEqual([201, 201]);
  });

  it("D18 사번 부재·공백·길이·실재를 구분하고 계정 미연결 작업자는 허용한다", async () => {
    for (const [workerNo, code] of [
      [null, "REQUIRED"],
      ["   ", "REQUIRED"],
      ["W".repeat(51), "RANGE"],
      [`${PREFIX}-UNKNOWN`, "INVALID"],
    ] as const) {
      const response = await postDowntime(createBody("writeWorker"), {
        workerNo,
      }).expect(400);
      expect(response.body.errors[0]).toMatchObject({
        field: "X-Worker-No",
        code,
      });
    }
    const created = await postDowntime(createBody("writeWorker")).expect(201);
    expect(created.body.recordedByWorkerNo).toBe(WORKER_NO);
  });

  it("D19 고객 확장 활성 사유만 허용하고 미등록·폐지 사유는 400이다", async () => {
    for (const reasonCode of [`${PREFIX}-UNKNOWN`, INACTIVE_REASON]) {
      const response = await postDowntime(
        createBody("writeClosed", {
          reasonCode,
          endedAt: "2026-09-08T00:00:00Z",
        }),
      ).expect(400);
      expect(response.body.errors[0]).toMatchObject({
        field: "reasonCode",
        code: "INVALID",
      });
    }
  });

  it("D20 미래 단말 시각과 0길이는 보존하고 역전만 두 필드 PAIR로 거절한다", async () => {
    const zero = await postDowntime(
      createBody("writeClosed", {
        startedAt: "2099-01-01T00:00:00.000001Z",
        endedAt: "2099-01-01T00:00:00.000001Z",
      }),
    ).expect(201);
    expect(zero.body).toMatchObject({
      startedAt: "2099-01-01T00:00:00.000001Z",
      endedAt: "2099-01-01T00:00:00.000001Z",
      durationMinutes: 0,
    });

    const reversed = await postDowntime(
      createBody("writeClosed", {
        startedAt: "2026-09-08T00:01:00Z",
        endedAt: "2026-09-08T00:00:59.999999Z",
      }),
    ).expect(400);
    expect(reversed.body.errors).toEqual([
      expect.objectContaining({ field: "startedAt", code: "PAIR" }),
      expect.objectContaining({ field: "endedAt", code: "PAIR" }),
    ]);
  });

  it("D21 offset·µs 6자리를 보존하고 초과 비영 자리만 RANGE다", async () => {
    const sameInstant = await postDowntime(
      createBody("writeClosed", {
        startedAt: "2026-09-01T07:00:00.123456+07:00",
        endedAt: "2026-09-01T00:00:00.123456Z",
      }),
    ).expect(201);
    expect(sameInstant.body).toMatchObject({
      startedAt: "2026-09-01T00:00:00.123456Z",
      endedAt: "2026-09-01T00:00:00.123456Z",
    });
    const trailingZeros = await postDowntime(
      createBody("writeClosed", {
        startedAt: "2026-09-01T00:00:00.123456000Z",
        endedAt: "2026-09-01T00:00:00.123456000Z",
      }),
    ).expect(201);
    expect(trailingZeros.body.startedAt).toBe("2026-09-01T00:00:00.123456Z");
    const ranged = await postDowntime(
      createBody("writeClosed", {
        startedAt: "2026-09-01T00:00:00.1234567Z",
        endedAt: "2026-09-01T00:00:01Z",
      }),
    ).expect(400);
    expect(ranged.body.errors[0]).toMatchObject({
      field: "startedAt",
      code: "RANGE",
    });
  });

  it("D22 고장 없음·다른 설비·완료 상태를 구분하고 열린 동일 설비만 연결한다", async () => {
    const absent = await postDowntime(
      createBody("writeClosed", {
        endedAt: "2026-09-08T00:00:00Z",
        breakdownId: 999999999,
      }),
    ).expect(400);
    expect(absent.body.errors[0]).toMatchObject({
      field: "breakdownId",
      code: "INVALID",
    });

    const otherEquipment = await postDowntime(
      createBody("writeClosed", {
        endedAt: "2026-09-08T00:00:00Z",
        breakdownId: Number(breakdowns.main),
      }),
    ).expect(400);
    expect(
      otherEquipment.body.errors.map((error: { code: string }) => error.code),
    ).toEqual(["PAIR", "PAIR"]);

    const done = await postDowntime(
      createBody("writeClosed", {
        endedAt: "2026-09-08T00:00:00Z",
        breakdownId: Number(breakdowns.doneWrite),
      }),
    ).expect(422);
    expect(done.body.errors[0]).toMatchObject({
      field: "breakdownId",
      code: "STATE_LOCKED",
    });

    const linked = await postDowntime(
      createBody("writeClosed", {
        endedAt: "2026-09-08T00:00:00Z",
        breakdownId: Number(breakdowns.receivedWrite),
      }),
    ).expect(201);
    expect(linked.body.breakdownId).toBe(Number(breakdowns.receivedWrite));

    const updateTarget = await postDowntime(
      createBody("updateValidation", {
        endedAt: "2026-09-08T00:00:00Z",
      }),
    ).expect(201);
    const updateCases = [
      [999999999, "INVALID"],
      [Number(breakdowns.main), "PAIR"],
      [Number(breakdowns.doneUpdateValidation), "STATE_LOCKED"],
    ] as const;
    for (const [breakdownId, code] of updateCases) {
      const rejected = await putDowntime(
        updateTarget.body.downtimeId,
        { breakdownId },
        { version: 1 },
      ).expect(400);
      expect(
        rejected.body.errors.map((error: { code: string }) => error.code),
      ).toContain(code);
    }
  });

  it("D23 같은 키·주체는 재생하고 다른 본문·계정·사번은 409다", async () => {
    const key = randomUUID();
    const body = createBody("writeIdempotent");
    const first = await postDowntime(body, { key }).expect(201);
    let replay: request.Response;
    try {
      await prisma.code_value.update({
        where: {
          code_group_id_code: {
            code_group_id: reasonGroupId,
            code: ACTIVE_REASON,
          },
        },
        data: { is_active: false },
      });
      replay = await postDowntime(body, { key }).expect(201);
    } finally {
      await prisma.code_value.update({
        where: {
          code_group_id_code: {
            code_group_id: reasonGroupId,
            code: ACTIVE_REASON,
          },
        },
        data: { is_active: true },
      });
    }
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.equipment_downtime.count({
        where: { equipment_id: equipment.writeIdempotent },
      }),
    ).toBe(1);

    for (const options of [
      { key, workerNo: OTHER_WORKER_NO },
      { key, authCookie: otherCookie },
    ]) {
      const conflict = await postDowntime(body, options).expect(409);
      expect(conflict.body).toMatchObject({ conflictCause: "user" });
    }
    const changed = await postDowntime(
      { ...body, remarks: "다른 본문" },
      { key },
    ).expect(409);
    expect(changed.body).toMatchObject({ conflictCause: "user" });
  });

  it("D24 멱등 완료 저장 실패는 비가동과 기록을 함께 롤백하고 재시도한다", async () => {
    const key = randomUUID();
    const body = createBody("writeRollback");
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, "update")
            .mockRejectedValueOnce(new Error("I32_COMPLETION_FAILURE"));
          try {
            return await (
              work as (client: Prisma.TransactionClient) => Promise<unknown>
            )(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await postDowntime(body, { key }).expect(500);
      expect(failed.text).not.toContain("I32_COMPLETION_FAILURE");
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await prisma.equipment_downtime.count({
        where: { equipment_id: equipment.writeRollback },
      }),
    ).toBe(0);
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
    await postDowntime(body, { key }).expect(201);
    expect(
      await prisma.equipment_downtime.count({
        where: { equipment_id: equipment.writeRollback },
      }),
    ).toBe(1);
  });

  it("D25 PUT 생략은 유지하고 null은 해제하며 시작·최초 사번은 불변이다", async () => {
    const created = await postDowntime(
      createBody("updateFields", {
        startedAt: "2026-09-08T07:00:00.123456+07:00",
        breakdownId: Number(breakdowns.receivedUpdateFields),
        remarks: "최초 메모",
      }),
    ).expect(201);
    const response = await putDowntime(
      created.body.downtimeId,
      {
        reasonCode: UPDATED_REASON,
        endedAt: "2026-09-08T00:15:00.123456Z",
        breakdownId: null,
        remarks: null,
      },
      { authCookie: otherCookie, version: 1 },
    ).expect(200);

    expect(response.body).toMatchObject({
      downtimeId: created.body.downtimeId,
      equipmentId: Number(equipment.updateFields),
      reasonCode: UPDATED_REASON,
      reasonName: "계획 정지",
      startedAt: "2026-09-08T00:00:00.123456Z",
      endedAt: "2026-09-08T00:15:00.123456Z",
      durationMinutes: 15,
      breakdownId: null,
      recordedByWorkerNo: WORKER_NO,
      remarks: null,
    });
    expect(updateValidator(response.body)).toBe(true);
    expect(response.headers.etag).not.toBe("2");
    const stored = await prisma.equipment_downtime.findUniqueOrThrow({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      select: {
        created_by: true,
        closed_by: true,
        recorded_by_worker_no: true,
        version_no: true,
      },
    });
    expect(stored).toEqual({
      created_by: actorUserId,
      closed_by: otherUserId,
      recorded_by_worker_no: WORKER_NO,
      version_no: 2,
    });
  });

  it("D26 PUT은 If-Match 필수·낡은 값 409이며 정상 수정만 version을 1 올린다", async () => {
    const created = await postDowntime(
      createBody("updateVersion", {
        endedAt: "2026-09-08T00:01:00Z",
      }),
    ).expect(201);
    await putDowntime(created.body.downtimeId, {}, { version: null }).expect(
      400,
    );
    await putDowntime(created.body.downtimeId, {}, { version: "wrong" }).expect(
      400,
    );
    const stale = await putDowntime(
      created.body.downtimeId,
      {},
      { version: 7 },
    ).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: "user" });
    const badReason = await putDowntime(
      created.body.downtimeId,
      { reasonCode: `${PREFIX}-UNKNOWN` },
      { version: 1 },
    ).expect(400);
    expect(badReason.body.errors[0]).toMatchObject({
      field: "reasonCode",
      code: "INVALID",
    });
    const reverse = await putDowntime(
      created.body.downtimeId,
      { endedAt: "2026-09-07T23:59:59.999999Z" },
      { version: 1 },
    ).expect(400);
    expect(
      reverse.body.errors.map((error: { code: string }) => error.code),
    ).toEqual(["PAIR", "PAIR"]);
    await putDowntime(
      created.body.downtimeId,
      { remarks: "정상 수정" },
      { version: 1 },
    ).expect(200);
    expect((await detail(BigInt(created.body.downtimeId))).headers.etag).toBe(
      "2",
    );
    await putDowntime(999999999, {}, { version: 1 }).expect(404);
  });

  it("D27 닫힌 행의 endedAt:null은 거부하고 열린 행의 null은 유지한다", async () => {
    const opened = await postDowntime(createBody("updateNullOpen")).expect(201);
    const keptOpen = await putDowntime(
      opened.body.downtimeId,
      { endedAt: null },
      { version: 1 },
    ).expect(200);
    expect(keptOpen.body.endedAt).toBeNull();
    expect((await detail(BigInt(opened.body.downtimeId))).headers.etag).toBe(
      "2",
    );

    const closed = await postDowntime(
      createBody("updateNullClosed", {
        endedAt: "2026-09-08T00:01:00Z",
      }),
    ).expect(201);
    const rejected = await putDowntime(
      closed.body.downtimeId,
      { endedAt: null },
      { version: 1 },
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: "endedAt",
      code: "STATE_LOCKED",
    });
    expect((await detail(BigInt(closed.body.downtimeId))).headers.etag).toBe(
      "1",
    );
  });

  it("D28 기존 연결 고장이 DONE이어도 연결 생략 메모 수정은 성공한다", async () => {
    await add(
      "updateOmittedDone",
      "updateOmitted",
      "2026-09-08T00:00:00Z",
      "2026-09-08T00:01:00Z",
      INACTIVE_REASON,
      WORKER_NO,
      1,
      breakdowns.doneUpdateOmitted,
    );
    const response = await putDowntime(
      Number(downtimes.updateOmittedDone),
      { remarks: "메모만 수정" },
      { version: 1 },
    ).expect(200);
    expect(response.body).toMatchObject({
      reasonCode: INACTIVE_REASON,
      breakdownId: Number(breakdowns.doneUpdateOmitted),
      endedAt: "2026-09-08T00:01:00.000000Z",
      remarks: "메모만 수정",
    });
    expect(response.body).not.toHaveProperty("reasonName");
  });

  it("D29 성공 재생은 폐지된 사유와 낡은 If-Match에도 최초 응답이다", async () => {
    const created = await postDowntime(createBody("updateIdempotent")).expect(
      201,
    );
    const key = randomUUID();
    const body = { reasonCode: ACTIVE_REASON, remarks: "한 번만" };
    const first = await putDowntime(created.body.downtimeId, body, {
      key,
      version: 1,
    }).expect(200);
    let replay: request.Response;
    try {
      await prisma.code_value.update({
        where: {
          code_group_id_code: {
            code_group_id: reasonGroupId,
            code: ACTIVE_REASON,
          },
        },
        data: { is_active: false },
      });
      replay = await putDowntime(created.body.downtimeId, body, {
        key,
        version: 999,
      }).expect(200);
    } finally {
      await prisma.code_value.update({
        where: {
          code_group_id_code: {
            code_group_id: reasonGroupId,
            code: ACTIVE_REASON,
          },
        },
        data: { is_active: true },
      });
    }
    expect(replay.body).toEqual(first.body);
    expect((await detail(BigInt(created.body.downtimeId))).headers.etag).toBe(
      "2",
    );
    await putDowntime(
      created.body.downtimeId,
      { ...body, remarks: "다른 본문" },
      { key, version: 2 },
    ).expect(409);
    await putDowntime(created.body.downtimeId, body, {
      authCookie: otherCookie,
      key,
      version: 2,
    }).expect(409);
  });

  it("D30 생성·수정은 고장·작업·보전·원장·알림 표를 쓰지 않는다", async () => {
    const before = await relatedCounts();
    const created = await postDowntime(
      createBody("updateRelated", { endedAt: "2026-09-08T00:00:00Z" }),
    ).expect(201);
    await putDowntime(
      created.body.downtimeId,
      { remarks: "관련 표 무변경" },
      { version: 1 },
    ).expect(200);
    expect(await relatedCounts()).toEqual(before);
  });

  it("D31 무권한은 403, 세션 없음은 401이고 멱등 헤더 형식도 공용 가드가 막는다", async () => {
    const body = createBody("writeClosed", {
      endedAt: "2026-09-08T00:00:00Z",
    });
    const forbidden = await postDowntime(body, {
      authCookie: noPermissionCookie,
    }).expect(403);
    expect(forbidden.body.errors[0]).toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await postDowntime(body, { authCookie: null }).expect(401);
    for (const key of [null, "not-a-uuid"]) {
      await postDowntime(body, { key }).expect(400);
    }

    const target = await postDowntime(
      createBody("updateAuth", { endedAt: "2026-09-08T00:01:00Z" }),
    ).expect(201);
    await putDowntime(
      target.body.downtimeId,
      {},
      {
        authCookie: noPermissionCookie,
        version: 1,
      },
    ).expect(403);
    await putDowntime(
      target.body.downtimeId,
      {},
      {
        authCookie: null,
        version: 1,
      },
    ).expect(401);
    await putDowntime(
      target.body.downtimeId,
      {},
      {
        key: null,
        version: 1,
      },
    ).expect(400);
  });

  it("D32 POST→GET→PUT→GET에서 숫자 ETag만 새 버전을 전달한다", async () => {
    const created = await postDowntime(createBody("updateEtag")).expect(201);
    expect(created.headers.etag).not.toBe("1");
    expect((await detail(BigInt(created.body.downtimeId))).headers.etag).toBe(
      "1",
    );
    const updated = await putDowntime(
      created.body.downtimeId,
      { remarks: "etag 갱신" },
      { version: 1 },
    ).expect(200);
    expect(updated.headers.etag).not.toBe("2");
    expect((await detail(BigInt(created.body.downtimeId))).headers.etag).toBe(
      "2",
    );
  });

  it("D33 필수 응답 결손 매핑 실패는 수정·version·멱등행을 롤백한다", async () => {
    const created = await postDowntime(
      createBody("updateRollback", {
        endedAt: "2026-09-08T00:01:00Z",
        remarks: "수정 전",
      }),
    ).expect(201);
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      data: { reason_code: null },
    });
    const key = randomUUID();
    await putDowntime(
      created.body.downtimeId,
      { remarks: "롤백되어야 함" },
      { key, version: 1 },
    ).expect(500);
    const stored = await prisma.equipment_downtime.findUniqueOrThrow({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      select: { remarks: true, version_no: true },
    });
    expect(stored).toEqual({ remarks: "수정 전", version_no: 1 });
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
  });

  it("D34 PUT 빈 객체는 본문 누락과 구분하며 원본 유지·version 1 증가다", async () => {
    const created = await postDowntime(
      createBody("updateEmpty", {
        endedAt: "2026-09-08T00:01:00Z",
        remarks: "그대로",
      }),
    ).expect(201);
    await request(app.getHttpServer())
      .put(`${PATH}/${created.body.downtimeId}`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .set("If-Match", "1")
      .expect(400);
    const response = await putDowntime(
      created.body.downtimeId,
      {},
      { version: 1 },
    ).expect(200);
    expect(response.body).toMatchObject({
      reasonCode: ACTIVE_REASON,
      startedAt: "2026-09-08T00:00:00.000000Z",
      endedAt: "2026-09-08T00:01:00.000000Z",
      breakdownId: null,
      recordedByWorkerNo: WORKER_NO,
      remarks: "그대로",
    });
    expect((await detail(BigInt(created.body.downtimeId))).headers.etag).toBe(
      "2",
    );
  });

  it("D36 쓰기 전 경로와 멱등 재생은 µs·원본 시작시각을 보존한다", async () => {
    const created = await postDowntime(
      createBody("updateExact", {
        startedAt: "2026-09-08T00:00:00.123456Z",
      }),
    ).expect(201);
    expect((await detail(BigInt(created.body.downtimeId))).body.startedAt).toBe(
      "2026-09-08T00:00:00.123456Z",
    );
    const key = randomUUID();
    const body = { endedAt: "2026-09-08T00:01:00.654321Z" };
    const updated = await putDowntime(created.body.downtimeId, body, {
      key,
      version: 1,
    }).expect(200);
    expect(updated.body).toMatchObject({
      startedAt: "2026-09-08T00:00:00.123456Z",
      endedAt: "2026-09-08T00:01:00.654321Z",
    });
    const fetched = await detail(BigInt(created.body.downtimeId));
    expect(fetched.body).toEqual(updated.body);
    expect(fetched.headers.etag).toBe("2");
    const replay = await putDowntime(created.body.downtimeId, body, {
      key,
      version: 777,
    }).expect(200);
    expect(replay.body).toEqual(updated.body);
  });

  it("C01 서버 수신시각으로 닫고 계정·사번을 분리하며 관련 표는 건드리지 않는다", async () => {
    const created = await postDowntime(createBody("closeServerTime")).expect(
      201,
    );
    const relatedBefore = await relatedCounts();
    const before = Date.now();
    const response = await closeDowntime(created.body.downtimeId, {
      authCookie: otherCookie,
      workerNo: OTHER_WORKER_NO,
    }).expect(200);
    const after = Date.now();

    expect(closeValidator(response.body)).toBe(true);
    expect(closeValidator.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({
      downtimeId: created.body.downtimeId,
      startedAt: "2026-09-08T00:00:00.000000Z",
      recordedByWorkerNo: WORKER_NO,
    });
    expect(response.body.endedAt).toMatch(/\.\d{6}Z$/);
    expect(Date.parse(response.body.endedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(response.body.endedAt)).toBeLessThanOrEqual(after);
    expect(await relatedCounts()).toEqual(relatedBefore);

    const stored = await prisma.$queryRaw<
      {
        closed_by: bigint | null;
        closed_by_worker_no: string | null;
        ended_text: string;
        version_no: number;
      }[]
    >`
      SELECT closed_by,closed_by_worker_no,version_no,
        to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ended_text
      FROM maintenance.equipment_downtime
      WHERE equipment_downtime_id=${BigInt(created.body.downtimeId)}`;
    expect(stored[0]).toEqual({
      closed_by: otherUserId,
      closed_by_worker_no: OTHER_WORKER_NO,
      ended_text: response.body.endedAt,
      version_no: 2,
    });
  });

  it("C02 If-Match는 선택이며 낡거나 잘못된 값만 거절한다", async () => {
    const optional = await postDowntime(createBody("closeOptional")).expect(
      201,
    );
    await closeDowntime(optional.body.downtimeId).expect(200);

    const stale = await postDowntime(createBody("closeStale")).expect(201);
    const conflict = await closeDowntime(stale.body.downtimeId, {
      version: 7,
    }).expect(409);
    expect(conflict.body).toMatchObject({ conflictCause: "user" });
    expect(
      (await detail(BigInt(stale.body.downtimeId))).body.endedAt,
    ).toBeNull();
    await closeDowntime(stale.body.downtimeId, { version: 1 }).expect(200);

    const malformed = await postDowntime(createBody("closeMalformed")).expect(
      201,
    );
    await closeDowntime(malformed.body.downtimeId, {
      version: "wrong",
    }).expect(400);

    const future = await postDowntime(
      createBody("closeFuture", { startedAt: "2099-01-01T00:00:00Z" }),
    ).expect(201);
    const reversed = await closeDowntime(future.body.downtimeId).expect(400);
    expect(
      reversed.body.errors.map((error: { code: string }) => error.code),
    ).toEqual(["PAIR", "PAIR"]);
  });

  it("C03 같은 키는 최초 종료를 재생하고 다른 요청과 재종료는 구분한다", async () => {
    const created = await postDowntime(createBody("closeReplay")).expect(201);
    const key = randomUUID();
    const first = await closeDowntime(created.body.downtimeId, {
      key,
      version: 1,
    }).expect(200);
    const replay = await closeDowntime(created.body.downtimeId, {
      key,
      version: 999,
    }).expect(200);
    expect(replay.body).toEqual(first.body);

    for (const options of [
      { key, workerNo: OTHER_WORKER_NO },
      { key, authCookie: otherCookie },
    ]) {
      const conflict = await closeDowntime(
        created.body.downtimeId,
        options,
      ).expect(409);
      expect(conflict.body).toMatchObject({ conflictCause: "user" });
    }
    const locked = await closeDowntime(created.body.downtimeId).expect(400);
    expect(locked.body.errors[0]).toMatchObject({
      field: "downtimeId",
      code: "STATE_LOCKED",
    });
    expect((await detail(BigInt(created.body.downtimeId))).headers.etag).toBe(
      "2",
    );
  });

  it("C04 동시 종료는 한 번만 반영하고 version도 한 번만 증가한다", async () => {
    const created = await postDowntime(createBody("closeConcurrent")).expect(
      201,
    );
    const responses = await Promise.all([
      closeDowntime(created.body.downtimeId),
      closeDowntime(created.body.downtimeId),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    const stored = await prisma.equipment_downtime.findUniqueOrThrow({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      select: { ended_at: true, version_no: true },
    });
    expect(stored.ended_at).not.toBeNull();
    expect(stored.version_no).toBe(2);
  });

  it("C05 사번·인증·권한을 검증하고 계정 미연결 작업자도 기록한다", async () => {
    const created = await postDowntime(createBody("closeWorker")).expect(201);
    for (const [workerNo, code] of [
      [null, "REQUIRED"],
      [`${PREFIX}-UNKNOWN`, "INVALID"],
      ["W".repeat(51), "RANGE"],
    ] as const) {
      const rejected = await closeDowntime(created.body.downtimeId, {
        workerNo,
      }).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({
        field: "X-Worker-No",
        code,
      });
    }
    await closeDowntime(created.body.downtimeId, {
      authCookie: null,
    }).expect(401);
    await closeDowntime(created.body.downtimeId, {
      authCookie: noPermissionCookie,
    }).expect(403);

    await closeDowntime(created.body.downtimeId, {
      workerNo: OTHER_WORKER_NO,
    }).expect(200);
    const stored = await prisma.equipment_downtime.findUniqueOrThrow({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      select: { closed_by: true, closed_by_worker_no: true },
    });
    expect(stored).toEqual({
      closed_by: actorUserId,
      closed_by_worker_no: OTHER_WORKER_NO,
    });
  });

  it("C06 응답 매핑 실패는 종료·version·멱등행을 함께 롤백한다", async () => {
    const created = await postDowntime(createBody("closeMapping")).expect(201);
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      data: { reason_code: null },
    });
    const key = randomUUID();
    await closeDowntime(created.body.downtimeId, { key }).expect(500);
    const stored = await prisma.equipment_downtime.findUniqueOrThrow({
      where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
      select: {
        ended_at: true,
        closed_by: true,
        closed_by_worker_no: true,
        version_no: true,
      },
    });
    expect(stored).toEqual({
      ended_at: null,
      closed_by: null,
      closed_by_worker_no: null,
      version_no: 1,
    });
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
  });

  it("C07 멱등 완료 저장 실패도 종료를 롤백하고 같은 키로 재시도한다", async () => {
    const created = await postDowntime(createBody("closeCompletion")).expect(
      201,
    );
    const key = randomUUID();
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, "update")
            .mockRejectedValueOnce(new Error("I32_CLOSE_COMPLETION_FAILURE"));
          try {
            return await (
              work as (client: Prisma.TransactionClient) => Promise<unknown>
            )(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await closeDowntime(created.body.downtimeId, {
        key,
      }).expect(500);
      expect(failed.text).not.toContain("I32_CLOSE_COMPLETION_FAILURE");
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await prisma.equipment_downtime.findUniqueOrThrow({
        where: { equipment_downtime_id: BigInt(created.body.downtimeId) },
        select: { ended_at: true, version_no: true },
      }),
    ).toEqual({ ended_at: null, version_no: 1 });
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
    await closeDowntime(created.body.downtimeId, { key }).expect(200);
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

  interface PostOptions {
    authCookie?: string[] | null;
    key?: string | null;
    workerNo?: string | null;
  }

  interface PutOptions {
    authCookie?: string[] | null;
    key?: string | null;
    version?: number | string | null;
  }

  interface CloseOptions extends PostOptions {
    version?: number | string | null;
  }

  function postDowntime(
    body: DowntimeCreate,
    options: PostOptions = {},
  ): request.Test {
    const call = request(app.getHttpServer()).post(PATH).send(body);
    const authCookie =
      options.authCookie === undefined ? cookie : options.authCookie;
    const key = options.key === undefined ? randomUUID() : options.key;
    const workerNo =
      options.workerNo === undefined ? WORKER_NO : options.workerNo;
    if (authCookie !== null) call.set("Cookie", authCookie);
    if (key !== null) call.set("Idempotency-Key", key);
    if (workerNo !== null) call.set("X-Worker-No", workerNo);
    return call;
  }

  function putDowntime(
    downtimeId: number,
    body: DowntimeUpdate,
    options: PutOptions = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .put(`${PATH}/${downtimeId}`)
      .send(body);
    const authCookie =
      options.authCookie === undefined ? cookie : options.authCookie;
    const key = options.key === undefined ? randomUUID() : options.key;
    const version = options.version === undefined ? 1 : options.version;
    if (authCookie !== null) call.set("Cookie", authCookie);
    if (key !== null) call.set("Idempotency-Key", key);
    if (version !== null) call.set("If-Match", String(version));
    return call;
  }

  function closeDowntime(
    downtimeId: number,
    options: CloseOptions = {},
  ): request.Test {
    const call = request(app.getHttpServer()).post(
      `${PATH}/${downtimeId}:close`,
    );
    const authCookie =
      options.authCookie === undefined ? cookie : options.authCookie;
    const key = options.key === undefined ? randomUUID() : options.key;
    const workerNo =
      options.workerNo === undefined ? WORKER_NO : options.workerNo;
    const version = options.version === undefined ? null : options.version;
    if (authCookie !== null) call.set("Cookie", authCookie);
    if (key !== null) call.set("Idempotency-Key", key);
    if (workerNo !== null) call.set("X-Worker-No", workerNo);
    if (version !== null) call.set("If-Match", String(version));
    return call;
  }

  function createBody(
    equipmentName: string,
    change: Partial<DowntimeCreate> = {},
  ): DowntimeCreate {
    return {
      equipmentId: Number(equipment[equipmentName]),
      reasonCode: ACTIVE_REASON,
      startedAt: "2026-09-08T00:00:00Z",
      ...change,
    };
  }

  async function relatedCounts(): Promise<Record<string, number>> {
    const [
      breakdown,
      workSession,
      workOrder,
      maintenanceOrder,
      maintenanceResult,
      inventory,
      notification,
    ] = await Promise.all([
      prisma.breakdown.count(),
      prisma.work_session.count(),
      prisma.work_order.count(),
      prisma.maintenance_order.count(),
      prisma.maintenance_result.count(),
      prisma.inventory_transaction.count(),
      prisma.notification.count(),
    ]);
    return {
      breakdown,
      workSession,
      workOrder,
      maintenanceOrder,
      maintenanceResult,
      inventory,
      notification,
    };
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
          code: UPDATED_REASON,
          code_name: "계획 정지",
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
    businessUnitId = business.business_unit_id;
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
      if (name === "hanoi") hanoiPlantId = plant.plant_id;
      for (const equipmentName of name === "hanoi"
        ? [
            "hanoi",
            "main",
            "overlap",
            "cross",
            "writeOpen",
            "writeClosed",
            "writeConcurrent",
            "writeParallelA",
            "writeParallelB",
            "writeWorker",
            "writeIdempotent",
            "writeRollback",
            "updateValidation",
            "updateFields",
            "updateVersion",
            "updateNullOpen",
            "updateNullClosed",
            "updateOmitted",
            "updateIdempotent",
            "updateRelated",
            "updateAuth",
            "updateEtag",
            "updateRollback",
            "updateEmpty",
            "updateExact",
            "closeServerTime",
            "closeOptional",
            "closeStale",
            "closeMalformed",
            "closeFuture",
            "closeReplay",
            "closeConcurrent",
            "closeWorker",
            "closeMapping",
            "closeCompletion",
            "summary",
          ]
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
    const summaryCalendar = await prisma.work_calendar.create({
      data: {
        calendar_code: `${PREFIX}-SUMMARY-CALENDAR`,
        calendar_name: "summary",
      },
    });
    await prisma.work_calendar_application.create({
      data: {
        work_calendar_id: summaryCalendar.work_calendar_id,
        target_type_code: "PLANT",
        target_id: hanoiPlantId,
        effective_from: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.work_calendar_day.create({
      data: {
        work_calendar_id: summaryCalendar.work_calendar_id,
        calendar_date: new Date("2026-09-01T00:00:00Z"),
        day_type_code: "WORKING",
      },
    });
    await prisma.shift.create({
      data: {
        plant_id: hanoiPlantId,
        shift_code: `${PREFIX}-SUMMARY-SHIFT`,
        shift_name: "summary",
        start_time: new Date("1970-01-01T08:00:00Z"),
        end_time: new Date("1970-01-01T16:00:00Z"),
      },
    });
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
    breakdowns.main = breakdown.breakdown_id;
    breakdowns.receivedWrite = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-BREAKDOWN-WRITE`,
          equipment_id: equipment.writeClosed,
          reported_at: new Date("2026-09-01T00:00:00Z"),
          status_code: "RECEIVED",
          description: "연결 가능 고장",
        },
      })
    ).breakdown_id;
    breakdowns.doneWrite = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-BREAKDOWN-DONE`,
          equipment_id: equipment.writeClosed,
          reported_at: new Date("2026-09-01T00:00:00Z"),
          status_code: "DONE",
          description: "완료 고장",
        },
      })
    ).breakdown_id;
    breakdowns.receivedUpdateFields = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-BREAKDOWN-UPDATE-FIELDS`,
          equipment_id: equipment.updateFields,
          reported_at: new Date("2026-09-01T00:00:00Z"),
          status_code: "RECEIVED",
          description: "수정 전 연결 고장",
        },
      })
    ).breakdown_id;
    breakdowns.doneUpdateOmitted = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-BREAKDOWN-UPDATE-OMITTED`,
          equipment_id: equipment.updateOmitted,
          reported_at: new Date("2026-09-01T00:00:00Z"),
          status_code: "DONE",
          description: "생략 시 유지할 완료 고장",
        },
      })
    ).breakdown_id;
    breakdowns.doneUpdateValidation = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-BREAKDOWN-UPDATE-VALIDATION`,
          equipment_id: equipment.updateValidation,
          reported_at: new Date("2026-09-01T00:00:00Z"),
          status_code: "DONE",
          description: "수정 신규 연결 불가 고장",
        },
      })
    ).breakdown_id;

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
    await add(
      "summaryMinor",
      "summary",
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:04:00Z",
    );
    await add(
      "summaryLong",
      "summary",
      "2026-09-01T00:02:00Z",
      "2026-09-01T00:08:00Z",
    );
    await add("summaryOpen", "summary", "2026-09-01T01:00:00Z", null);
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
    const calendars = await client.work_calendar.findMany({
      where: { calendar_code: `${PREFIX}-SUMMARY-CALENDAR` },
      select: { work_calendar_id: true },
    });
    const calendarIds = calendars.map((row) => row.work_calendar_id);
    await client.work_calendar_day.deleteMany({
      where: { work_calendar_id: { in: calendarIds } },
    });
    await client.work_calendar_application.deleteMany({
      where: { work_calendar_id: { in: calendarIds } },
    });
    await client.work_calendar.deleteMany({
      where: { work_calendar_id: { in: calendarIds } },
    });
    await client.shift.deleteMany({
      where: { shift_code: `${PREFIX}-SUMMARY-SHIFT` },
    });
    await client.equipment_downtime.deleteMany({
      where: { equipment: { equipment_code: { startsWith: `${PREFIX}-` } } },
    });
    await client.breakdown.deleteMany({
      where: { breakdown_no: { startsWith: `${PREFIX}-BREAKDOWN` } },
    });
    await client.worker.deleteMany({
      where: { worker_no: { in: [WORKER_NO, OTHER_WORKER_NO] } },
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
    await client.user_role.deleteMany({
      where: { role: { role_code: ROLE } },
    });
    await client.role_permission.deleteMany({
      where: { role: { role_code: ROLE } },
    });
    await client.role.deleteMany({ where: { role_code: ROLE } });
    const users = await client.app_user.findMany({
      where: {
        login_id: {
          in: [LOGIN_ID, OTHER_LOGIN_ID, NO_PERMISSION_LOGIN_ID],
        },
      },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    if (userIds.length) {
      await client.idempotency_record.deleteMany({
        where: { app_user_id: { in: userIds } },
      });
      await client.user_credential.deleteMany({
        where: { app_user_id: { in: userIds } },
      });
      await client.app_user.deleteMany({
        where: { app_user_id: { in: userIds } },
      });
    }
    await client.code_value.deleteMany({
      where: {
        code: { in: [ACTIVE_REASON, UPDATED_REASON, INACTIVE_REASON] },
      },
    });
    if (createdReasonGroup && reasonGroupId) {
      await client.code_group.deleteMany({
        where: { code_group_id: reasonGroupId, code_value: { none: {} } },
      });
    }
    if (!prisma) await (client as PrismaClient).$disconnect();
  }
});
