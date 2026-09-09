import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { PrismaService } from "../src/prisma/prisma.service";

const LOGIN_ID = "e2e-audit-event-probe";
const NOPERM_ID = "e2e-audit-event-noperm";
const PASSWORD = "감사이력-검사-비밀번호";
const ROLE = "E2E_AUDIT_EVENT";
const PREFIX = "AUDIT-E2E";
const PATH = "/api/audit/events";
const BASE = "2026-04-01T00:00:00.000Z";

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, "../contracts/mdm-기준정보.json"), "utf8"),
  ) as object;
  const pointer =
    "/paths/~1audit~1events/get/responses/200/content/application~1json/schema";
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

const at = (minutes: number): Date =>
  new Date(Date.parse(BASE) + minutes * 60_000);
const iso = (minutes: number): string => at(minutes).toISOString();

describe("감사 이력 조회 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let performedBy: number;
  let sortIds: number[];

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

  it("⛔ 기간 한쪽이 없으면 각각 400이다", async () => {
    await request(app.getHttpServer())
      .get(`${PATH}?occurredTo=${encodeURIComponent(iso(60))}`)
      .set("Cookie", cookie)
      .expect(400);
    await request(app.getHttpServer())
      .get(`${PATH}?occurredFrom=${encodeURIComponent(iso(0))}`)
      .set("Cookie", cookie)
      .expect(400);
  });

  it("⛔ 권한이 없으면 403이다", async () => {
    await request(app.getHttpServer())
      .get(range())
      .set("Cookie", noPermCookie)
      .expect(403);
  });

  it("⭐ 기간은 From 포함·To 제외 반개구간이다 — 통보 270", async () => {
    const response = await get({ correlationId: `${PREFIX}-BOUNDARY` });
    expect(
      response.body.items.map((item: { reason: string }) => item.reason),
    ).toEqual(["BOUNDARY-START"]);
  });

  it("⭐ 선택 필터 다섯이 모두 같은 where와 count에 걸린다", async () => {
    const response = await get({
      targetTypeCode: "ITEM",
      targetId: "7001",
      eventTypeCode: "UPDATE",
      performedBy: String(performedBy),
      correlationId: `${PREFIX}-FILTER`,
    });
    expect(response.body.page.total).toBe(1);
    expect(
      response.body.items.map((item: { reason: string }) => item.reason),
    ).toEqual(["FILTER-MATCH"]);
  });

  it("⭐ 같은 occurredAt은 auditEventId desc로 닫는다", async () => {
    const response = await get({ correlationId: `${PREFIX}-SORT` });
    expect(
      response.body.items.map(
        (item: { auditEventId: number }) => item.auditEventId,
      ),
    ).toEqual([...sortIds].sort((a, b) => b - a));
  });

  it("⭐ 페이지 items와 count가 같은 필터를 쓰고 계약 스키마를 만족한다", async () => {
    const response = await get({ correlationId: `${PREFIX}-SORT`, size: "1" });
    expect(response.body.items).toHaveLength(1);
    expect(response.body.page).toEqual({ page: 1, size: 1, total: 2 });
    const validate = validator();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it("⭐ required·nullable·알 수 없는 JSON 키를 물리 원천 그대로 낸다", async () => {
    const response = await get({ correlationId: `${PREFIX}-PROJECTION` });
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      occurredAt: iso(40),
      targetTypeCode: "APP_USER",
      targetId: 8801,
      eventTypeCode: "GRANT",
      beforeValue: { unknownBefore: "kept", roleIds: [1] },
      afterValue: { unknownAfter: 7, roleIds: [1, 2] },
      reason: null,
      performedBy,
      terminalId: null,
      correlationId: `${PREFIX}-PROJECTION`,
    });
  });

  it("⛔ 계약 enum 밖 targetTypeCode는 400이다", async () => {
    await request(app.getHttpServer())
      .get(range({ targetTypeCode: "WAREHOUSE" }))
      .set("Cookie", cookie)
      .expect(400);
  });

  function get(extra: Record<string, string> = {}): request.Test {
    return request(app.getHttpServer())
      .get(range(extra))
      .set("Cookie", cookie)
      .expect(200);
  }

  function range(extra: Record<string, string> = {}): string {
    const query = new URLSearchParams({
      occurredFrom: iso(0),
      occurredTo: iso(60),
      ...extra,
    });
    return `${PATH}?${query.toString()}`;
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
        user_name: "감사이력검사",
        status_code: "EMPLOYED",
      },
    });
    performedBy = Number(user.app_user_id);
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const noPerm = await prisma.app_user.create({
      data: {
        login_id: NOPERM_ID,
        user_name: "감사권한없음",
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
      data: { role_code: ROLE, role_name: "감사이력검사용" },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: "W-06-11" },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);

    await event(
      0,
      "ITEM",
      1,
      "UPDATE",
      performedBy,
      `${PREFIX}-BOUNDARY`,
      "BOUNDARY-START",
    );
    await event(
      60,
      "ITEM",
      1,
      "UPDATE",
      performedBy,
      `${PREFIX}-BOUNDARY`,
      "BOUNDARY-END",
    );

    const firstSort = await event(
      30,
      "ROLE",
      2,
      "UPDATE",
      performedBy,
      `${PREFIX}-SORT`,
      "SORT-1",
    );
    const secondSort = await event(
      30,
      "ROLE",
      3,
      "UPDATE",
      performedBy,
      `${PREFIX}-SORT`,
      "SORT-2",
    );
    sortIds = [firstSort, secondSort];

    await event(
      20,
      "ITEM",
      7001,
      "UPDATE",
      performedBy,
      `${PREFIX}-FILTER`,
      "FILTER-MATCH",
    );
    await event(
      20,
      "ROLE",
      7001,
      "UPDATE",
      performedBy,
      `${PREFIX}-FILTER`,
      "FILTER-TYPE",
    );
    await event(
      20,
      "ITEM",
      7002,
      "UPDATE",
      performedBy,
      `${PREFIX}-FILTER`,
      "FILTER-TARGET",
    );
    await event(
      20,
      "ITEM",
      7001,
      "CREATE",
      performedBy,
      `${PREFIX}-FILTER`,
      "FILTER-EVENT",
    );
    await event(
      20,
      "ITEM",
      7001,
      "UPDATE",
      performedBy + 999,
      `${PREFIX}-FILTER`,
      "FILTER-ACTOR",
    );
    await event(
      20,
      "ITEM",
      7001,
      "UPDATE",
      performedBy,
      `${PREFIX}-OTHER`,
      "FILTER-CORRELATION",
    );

    await prisma.audit_event.create({
      data: {
        occurred_at: at(40),
        target_type_code: "APP_USER",
        target_id: 8801,
        event_type_code: "GRANT",
        before_value: { unknownBefore: "kept", roleIds: [1] },
        after_value: { unknownAfter: 7, roleIds: [1, 2] },
        performed_by: user.app_user_id,
        correlation_id: `${PREFIX}-PROJECTION`,
      },
    });
  }

  async function event(
    minute: number,
    targetTypeCode: string,
    targetId: number,
    eventTypeCode: string,
    actor: number,
    correlationId: string,
    reason: string,
  ): Promise<number> {
    const row = await prisma.audit_event.create({
      data: {
        occurred_at: at(minute),
        target_type_code: targetTypeCode,
        target_id: targetId,
        event_type_code: eventTypeCode,
        performed_by: actor,
        correlation_id: correlationId,
        reason,
      },
    });
    return Number(row.audit_event_id);
  }

  async function cleanup(): Promise<void> {
    await prisma.audit_event.deleteMany({
      where: { correlation_id: { startsWith: PREFIX } },
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
  }
});
