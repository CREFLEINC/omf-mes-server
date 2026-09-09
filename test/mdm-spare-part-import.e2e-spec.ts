import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Workbook } from "exceljs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { PrismaService } from "../src/prisma/prisma.service";

const LOGIN_ID = "e2e-spare-import-probe";
const NOPERM_ID = "e2e-spare-import-noperm";
const PASSWORD = "예비품엑셀-검사-비밀번호";
const ROLE = "E2E_SPARE_IMPORT";
const PREFIX = "SPIMPORT";
const PATH = "/api/mdm/spare-parts:import";

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, "../contracts/mdm-기준정보.json"), "utf8"),
  ) as object;
  const pointer =
    "/paths/~1mdm~1spare-parts:import/post/responses/200/content/application~1json/schema";
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of [
    "int64",
    "int32",
    "double",
    "float",
    "binary",
    "password",
  ]) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, "https://omf-mes.invalid/contract");
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe("예비품 엑셀 올리기 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantCodes: [string, string];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "api");
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixture();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("⛔ 파일이 없거나 읽을 수 없거나 필수 머리글이 없으면 400이다", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .expect(400);

    await upload(Buffer.from("엑셀이 아니다"), randomUUID()).expect(400);
    await upload(
      await workbook([["알 수 없는 열"], ["값"]]),
      randomUUID(),
    ).expect(400);
  });

  it("⛔ 권한이 없으면 403이다", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", noPermCookie)
      .set("Idempotency-Key", randomUUID())
      .attach(
        "file",
        await workbook([
          ["공장코드", "예비품코드", "예비품명"],
          [plantCodes[0], `${PREFIX}-NOPERM`, "권한없음"],
        ]),
        "spare-parts.xlsx",
      )
      .expect(403);
  });

  it("⭐ 성공·필수값·길이·없는 공장·파일 내 중복을 행별로 나눈다", async () => {
    const file = await workbook([
      ["공장코드", "예비품코드", "예비품명", "계약에 없는 열"],
      [plantCodes[0], `${PREFIX}-PARTIAL`, "첫 공장 씰", "무시"],
      [plantCodes[0], "", "코드 없음", null],
      [plantCodes[0], `${PREFIX}-NO-NAME`, "", null],
      ["NO-SUCH-PLANT", `${PREFIX}-UNKNOWN`, "없는 공장", null],
      [plantCodes[0], `${PREFIX}-PARTIAL`, "중복", null],
      [plantCodes[1], `${PREFIX}-PARTIAL`, "둘째 공장 씰", null],
      [plantCodes[0], "X".repeat(51), "코드가 너무 김", null],
      [plantCodes[0], `${PREFIX}-LONG-NAME`, "Y".repeat(201), null],
    ]);

    const response = await upload(file, randomUUID()).expect(200);
    const validate = validator();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.succeeded).toBe(2);
    expect(
      response.body.failed.map((failure: { index: number }) => failure.index),
    ).toEqual([1, 2, 3, 4, 6, 7]);
    expect(response.body.failed[0].errors[0]).toMatchObject({
      field: "sparePartCode",
      code: "REQUIRED",
    });
    expect(response.body.failed[1].errors[0]).toMatchObject({
      field: "sparePartName",
      code: "REQUIRED",
    });
    expect(response.body.failed[2].errors[0]).toMatchObject({
      field: "plantId",
      code: "INVALID",
    });
    expect(response.body.failed[3]).toMatchObject({
      key: `${PREFIX}-PARTIAL`,
      errors: [
        expect.objectContaining({
          field: "sparePartCode",
          code: "UNIQUE_VIOLATION",
        }),
      ],
    });
    expect(response.body.failed[4].errors[0]).toMatchObject({
      field: "sparePartCode",
      code: "RANGE",
    });
    expect(response.body.failed[5].errors[0]).toMatchObject({
      field: "sparePartName",
      code: "RANGE",
    });
    expect(
      await prisma.spare_part.count({
        where: { spare_part_code: `${PREFIX}-PARTIAL` },
      }),
    ).toBe(2);
  });

  it("⭐ DB에 이미 있는 동일 공장 코드는 그 행만 UNIQUE_VIOLATION으로 거부한다", async () => {
    const plant = await prisma.plant.findFirstOrThrow({
      where: { plant_code: plantCodes[0] },
      select: { plant_id: true },
    });
    await prisma.spare_part.create({
      data: {
        plant_id: plant.plant_id,
        spare_part_code: `${PREFIX}-EXISTING`,
        spare_part_name: "기존 예비품",
      },
    });

    const response = await upload(
      await workbook([
        ["공장코드", "예비품코드", "예비품명"],
        [plantCodes[0], `${PREFIX}-EXISTING`, "중복 업로드"],
      ]),
      randomUUID(),
    ).expect(200);
    expect(response.body).toMatchObject({
      succeeded: 0,
      failed: [
        {
          index: 0,
          key: `${PREFIX}-EXISTING`,
          errors: [
            expect.objectContaining({
              field: "sparePartCode",
              code: "UNIQUE_VIOLATION",
            }),
          ],
        },
      ],
    });
  });

  it("⭐ 공장 열이 없고 공장이 여럿이면 추정하지 않고 그 행만 실패시킨다", async () => {
    const response = await upload(
      await workbook([
        ["예비품코드", "예비품명"],
        [`${PREFIX}-NOPLANT`, "공장 없음"],
      ]),
      randomUUID(),
    ).expect(200);
    expect(response.body).toMatchObject({
      succeeded: 0,
      failed: [
        {
          index: 0,
          key: `${PREFIX}-NOPLANT`,
          errors: [
            expect.objectContaining({ field: "plantId", code: "REQUIRED" }),
          ],
        },
      ],
    });
  });

  it("⭐ 같은 키·같은 파일은 재생하고 같은 키·다른 파일은 409다 — 파일 digest 지문", async () => {
    const idempotencyKey = randomUUID();
    const firstFile = await workbook([
      ["공장코드", "예비품코드", "예비품명"],
      [plantCodes[0], `${PREFIX}-REPLAY`, "재생 대상"],
    ]);
    const first = await upload(firstFile, idempotencyKey).expect(200);
    const replay = await upload(firstFile, idempotencyKey).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.spare_part.count({
        where: { spare_part_code: `${PREFIX}-REPLAY` },
      }),
    ).toBe(1);

    const differentFile = await workbook([
      ["공장코드", "예비품코드", "예비품명"],
      [plantCodes[0], `${PREFIX}-DIFFERENT`, "다른 파일"],
    ]);
    await upload(differentFile, idempotencyKey).expect(409);
    expect(
      await prisma.spare_part.count({
        where: { spare_part_code: `${PREFIX}-DIFFERENT` },
      }),
    ).toBe(0);
  });

  function upload(file: Buffer, idempotencyKey: string): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", idempotencyKey)
      .attach("file", file, "spare-parts.xlsx");
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers["set-cookie"];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeFixture(): Promise<void> {
    const user = await prisma.app_user.create({
      data: {
        login_id: LOGIN_ID,
        user_name: "예비품엑셀검사",
        status_code: "EMPLOYED",
      },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const noPerm = await prisma.app_user.create({
      data: {
        login_id: NOPERM_ID,
        user_name: "예비품엑셀권한없음",
        status_code: "EMPLOYED",
      },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: noPerm.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: "예비품엑셀검사용" },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: "W-06-08" },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: "예비품엑셀법인",
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    plantCodes = [`${PREFIX}-P1`, `${PREFIX}-P2`];
    for (const [index, plantCode] of plantCodes.entries()) {
      await prisma.plant.create({
        data: {
          legal_entity_id: entity.legal_entity_id,
          plant_code: plantCode,
          plant_name: `예비품엑셀공장${index + 1}`,
          timezone_code: "Asia/Ho_Chi_Minh",
        },
      });
    }
  }

  async function cleanup(): Promise<void> {
    await prisma.spare_part.deleteMany({
      where: { spare_part_code: { startsWith: PREFIX } },
    });
    const users = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    await prisma.idempotency_record.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.user_role.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.user_credential.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.app_user.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    const roles = await prisma.role.findMany({
      where: { role_code: ROLE },
      select: { role_id: true },
    });
    const roleIds = roles.map((role) => role.role_id);
    await prisma.role_permission.deleteMany({
      where: { role_id: { in: roleIds } },
    });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.plant.deleteMany({
      where: { plant_code: { in: [`${PREFIX}-P1`, `${PREFIX}-P2`] } },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: `${PREFIX}-LE` },
    });
  }
});

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const book = new Workbook();
  const sheet = book.addWorksheet("예비품");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}
