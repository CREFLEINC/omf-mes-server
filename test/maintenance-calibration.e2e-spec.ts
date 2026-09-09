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
const PASSWORD = "I-33-검교정-조회-검증-비밀번호";

describe("검교정 이력 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let calibrationId: number;

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
    const rows = await prisma.$queryRaw<{ equipment_calibration_id: bigint }[]>(Prisma.sql`
      INSERT INTO quality.equipment_calibration
        (equipment_id, calibration_date, result_code, valid_until, certificate_no,
         calibrated_by, remarks, history_type_code, agency_type_code, agency_name,
         tolerance_note, recorded_by, blocks_use, cleared_at, cleared_by)
      VALUES
        (${equipment.equipment_id}, '2026-09-09'::date, 'PASS', '2027-09-09'::date,
         'CERT-I33-31', NULL, '정기 검교정', 'CALIBRATION', 'EXTERNAL', '한국계측인증',
         '±0.02 mm', ${user.app_user_id}, true,
         '2026-09-09 08:02:03.123456+07'::timestamptz, ${user.app_user_id})
      RETURNING equipment_calibration_id`);
    calibrationId = Number(rows[0].equipment_calibration_id);
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
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
