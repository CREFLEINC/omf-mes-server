import { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E_I33_CAL";
const LOGIN_ID = `${PREFIX}-USER`;
const ROLE = `${PREFIX}-ROLE`;
const CUSTOM_RESULT = `${PREFIX}_CUSTOM`;
const PASSWORD = "I-33-검교정-조회-검증-비밀번호";

describe("검교정 이력 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let calibrationId: number;
  let equipmentId: number;
  let actorUserId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "api");
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();

    const plant = await prisma.plant.findFirstOrThrow();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: "I-33 검교정 조회", status_code: "EMPLOYED" },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    actorUserId = Number(user.app_user_id);
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: ROLE } });
    for (const permissionCode of ["W-05-10", "W-05-11"]) {
      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: permissionCode },
      });
    }
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const resultGroup = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: "CALIBRATION_RESULT" },
    });
    await prisma.code_value.create({
      data: {
        code_group_id: resultGroup.code_group_id,
        code: CUSTOM_RESULT,
        code_name: "의미 미정 확장 결과",
      },
    });
    const equipment = await prisma.equipment.create({
      data: {
        plant_id: plant.plant_id,
        equipment_code: `${PREFIX}-EQ`,
        equipment_name: "검교정 조회 계측기",
        equipment_type_code: "MEASURING",
        status_code: "RUNNING",
        calibration_required: true,
      },
    });
    const rows = await prisma.$queryRaw<
      { equipment_calibration_id: bigint; history_type_code: string }[]
    >(Prisma.sql`
      INSERT INTO quality.equipment_calibration
        (equipment_id, calibration_date, result_code, valid_until, certificate_no,
         calibrated_by, remarks, history_type_code, agency_type_code, agency_name,
         tolerance_note, recorded_by, blocks_use, cleared_at, cleared_by)
      VALUES
        (${equipment.equipment_id}, '2026-09-09'::date, 'PASS', '2027-09-09'::date,
         'CERT-I33-31', NULL, '정기 검교정', 'CALIBRATION', 'EXTERNAL', '한국계측인증',
         '±0.02 mm', ${user.app_user_id}, true,
         '2026-09-09 08:02:03.123456+07'::timestamptz, ${user.app_user_id}),
        (${equipment.equipment_id}, '2026-09-08'::date, 'NORMAL', '2026-09-30'::date,
         NULL, ${user.app_user_id}, NULL, 'CHECK', NULL, NULL,
         NULL, ${user.app_user_id}, false, NULL, NULL)
      RETURNING equipment_calibration_id, history_type_code`);
    calibrationId = Number(
      rows.find((row) => row.history_type_code === "CALIBRATION")?.equipment_calibration_id,
    );
    equipmentId = Number(equipment.equipment_id);
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("상세는 계약 16칸과 clearedAt 마이크로초를 원천값 그대로 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/calibrations/${calibrationId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body).toEqual({
      calibrationId,
      equipmentId: expect.any(Number),
      equipmentCode: `${PREFIX}-EQ`,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-09",
      resultCode: "PASS",
      certificateNo: "CERT-I33-31",
      agencyTypeCode: "EXTERNAL",
      agencyName: "한국계측인증",
      nextDueOn: "2027-09-09",
      toleranceNote: "±0.02 mm",
      recordedByUserId: expect.any(Number),
      performedByUserId: null,
      remarks: "정기 검교정",
      blocksUse: true,
      clearedAt: "2026-09-09T01:02:03.123456Z",
    });
  });

  it("없는 상세는 404다", async () => {
    await request(app.getHttpServer())
      .get("/api/maintenance/calibrations/999999999")
      .set("Cookie", cookie)
      .expect(404);
  });

  it("목록은 수행일·ID 역순 페이지와 필터 전체 count를 함께 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/calibrations?equipmentId=${equipmentId}&page=1&size=1`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].calibrationId).toBe(calibrationId);
    expect(response.body.totalCount).toBe(2);
    expect(response.body.page).toEqual({ page: 1, size: 1, total: 2 });
  });

  it("목록은 유형·수행기간을 함께 거르고 dueBefore를 미만으로 비교한다", async () => {
    const included = await request(app.getHttpServer())
      .get(
        `/api/maintenance/calibrations?equipmentId=${equipmentId}` +
          "&historyTypeCode=CHECK&performedFrom=2026-09-08&performedTo=2026-09-08" +
          "&dueBefore=2026-10-01",
      )
      .set("Cookie", cookie)
      .expect(200);
    expect(included.body.items).toHaveLength(1);
    expect(included.body.items[0]).toMatchObject({
      historyTypeCode: "CHECK",
      performedOn: "2026-09-08",
      nextDueOn: "2026-09-30",
    });

    const boundary = await request(app.getHttpServer())
      .get(`/api/maintenance/calibrations?equipmentId=${equipmentId}&dueBefore=2026-09-30`)
      .set("Cookie", cookie)
      .expect(200);
    expect(boundary.body).toMatchObject({ items: [], totalCount: 0 });
  });

  it("CHECK는 필수 네 칸만으로 이력을 남기고 설비 마스터는 바꾸지 않는다", async () => {
    const before = await equipmentState();
    const response = await post({
      equipmentId,
      historyTypeCode: "CHECK",
      performedOn: "2026-09-10",
      resultCode: "PASS",
    }).expect(201);
    expect(response.body).toMatchObject({
      equipmentId,
      historyTypeCode: "CHECK",
      performedOn: "2026-09-10",
      resultCode: "PASS",
      recordedByUserId: actorUserId,
      performedByUserId: null,
      blocksUse: false,
      clearedAt: null,
    });
    expect(await equipmentState()).toEqual(before);
  });

  it("같은 날 다른 유형은 허용하고 같은 유형 중복은 세 축의 400이다", async () => {
    await post({
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-10",
      resultCode: "FAIL",
    }).expect(201);
    const duplicate = await post({
      equipmentId,
      historyTypeCode: "CHECK",
      performedOn: "2026-09-10",
      resultCode: "PASS",
    }).expect(400);
    expect(duplicate.body.errors).toContainEqual(
      expect.objectContaining({
        code: "UNIQUE_VIOLATION",
        uniqueScope: ["equipmentId", "performedOn", "historyTypeCode"],
      }),
    );
  });

  it("외부 기관은 이름이 필요하고 내부 수행자와 짝지을 수 없다", async () => {
    const before = await prisma.equipment_calibration.count({
      where: { equipment_id: BigInt(equipmentId) },
    });
    const missingName = await post({
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-15",
      resultCode: "PASS",
      agencyTypeCode: "EXTERNAL",
    }).expect(400);
    expect(missingName.body.errors).toContainEqual(
      expect.objectContaining({ field: "agencyName", code: "REQUIRED" }),
    );
    const pairedPerformer = await post({
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-15",
      resultCode: "PASS",
      agencyTypeCode: "EXTERNAL",
      agencyName: "외부기관",
      performedByUserId: actorUserId,
    }).expect(400);
    expect(pairedPerformer.body.errors).toContainEqual(
      expect.objectContaining({ field: "performedByUserId", code: "PAIR" }),
    );
    expect(
      await prisma.equipment_calibration.count({ where: { equipment_id: BigInt(equipmentId) } }),
    ).toBe(before);
  });

  it("CALIBRATION PASS는 이력·마스터를 원자 갱신하고 같은 키는 재생한다", async () => {
    const key = randomUUID();
    const body = {
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-11",
      resultCode: "PASS",
      agencyTypeCode: "EXTERNAL",
      agencyName: "한국계측인증",
      nextDueOn: "2027-09-11",
      blocksUse: true,
    };
    const first = await post(body, key).expect(201);
    const replay = await post(body, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      recordedByUserId: actorUserId,
      performedByUserId: null,
      agencyTypeCode: "EXTERNAL",
      agencyName: "한국계측인증",
      blocksUse: true,
    });
    expect(await equipmentState()).toEqual({
      last: "2026-09-11",
      due: "2027-09-11",
      version: 2,
    });
    expect(
      await prisma.equipment_calibration.count({
        where: {
          equipment_id: BigInt(equipmentId),
          calibration_date: new Date("2026-09-11T00:00:00.000Z"),
          history_type_code: "CALIBRATION",
        },
      }),
    ).toBe(1);
  });

  it("FAIL은 기한을 이력에만 남기고 ADJUSTED는 null 기한까지 마스터에 반영한다", async () => {
    await post({
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-12",
      resultCode: "FAIL",
      nextDueOn: "2028-09-12",
    }).expect(201);
    expect(await equipmentState()).toEqual({
      last: "2026-09-11",
      due: "2027-09-11",
      version: 2,
    });

    await post({
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-13",
      resultCode: "ADJUSTED",
      nextDueOn: null,
    }).expect(201);
    expect(await equipmentState()).toEqual({ last: "2026-09-13", due: null, version: 3 });
  });

  it("CALIBRATION의 활성 확장 결과는 422이며 이력·마스터를 쓰지 않는다", async () => {
    const before = await equipmentState();
    const count = await prisma.equipment_calibration.count({
      where: { equipment_id: BigInt(equipmentId) },
    });
    const response = await post({
      equipmentId,
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-14",
      resultCode: CUSTOM_RESULT,
    }).expect(422);
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "resultCode", code: "STATE_LOCKED" }),
    );
    expect(await equipmentState()).toEqual(before);
    expect(
      await prisma.equipment_calibration.count({ where: { equipment_id: BigInt(equipmentId) } }),
    ).toBe(count);
  });

  function post(body: object, key: string = randomUUID()): request.Test {
    return request(app.getHttpServer())
      .post("/api/maintenance/calibrations")
      .set("Cookie", cookie)
      .set("Idempotency-Key", key)
      .send(body);
  }

  async function equipmentState(): Promise<{ last: string | null; due: string | null; version: number }> {
    const row = await prisma.equipment.findUniqueOrThrow({
      where: { equipment_id: BigInt(equipmentId) },
      select: { last_calibration_date: true, calibration_due_date: true, version_no: true },
    });
    return {
      last: row.last_calibration_date?.toISOString().slice(0, 10) ?? null,
      due: row.calibration_due_date?.toISOString().slice(0, 10) ?? null,
      version: row.version_no,
    };
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers["set-cookie"];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    await prisma.equipment_calibration.deleteMany({
      where: { equipment: { equipment_code: { startsWith: PREFIX } } },
    });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.code_value.deleteMany({ where: { code: CUSTOM_RESULT } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
