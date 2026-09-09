import { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E_I33_TOOL";
const LOGIN_ID = `${PREFIX}-USER`;
const PASSWORD = "I-33-툴-조회-검증-비밀번호";

describe("툴 사용실적 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let usageId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "api");
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();

    const [plant, unit, uom] = await Promise.all([
      prisma.plant.findFirstOrThrow(),
      prisma.business_unit.findFirstOrThrow(),
      prisma.uom.findFirstOrThrow(),
    ]);
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: "I-33 툴 조회", status_code: "EMPLOYED" },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WORKER`,
        worker_name: "툴 기록 작업자",
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        app_user_id: user.app_user_id,
        status_code: "EMPLOYED",
      },
    });
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`,
        item_name: "툴 조회 품목",
        item_type_code: "FINISHED_GOODS",
        base_uom_id: uom.uom_id,
      },
    });
    const process = await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PROCESS`,
        process_name: "툴 조회 공정",
        process_type_code: "MOLDING",
      },
    });
    const routing = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-ROUTING`,
        routing_version: 1,
        status_code: "ACTIVE",
      },
    });
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 10,
        process_id: process.process_id,
        operation_name: "툴 조회 공정",
      },
    });
    const order = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: "PLANNED",
      },
    });
    const mold = await prisma.mold.create({
      data: {
        plant_id: plant.plant_id,
        mold_code: `${PREFIX}-MOLD`,
        mold_name: "툴 조회 금형",
        status_code: "IN_USE",
        tool_type_code: "MOLD",
      },
    });
    const rows = await prisma.$queryRaw<{ tool_usage_id: bigint }[]>(Prisma.sql`
      INSERT INTO maintenance.tool_usage
        (mold_id, work_order_id, shot_count, collection_method_code, occurred_at, recorded_by)
      VALUES
        (${mold.mold_id}, ${order.work_order_id}, 1250, 'DIRECT',
         '2026-09-09 08:02:03.123456+07'::timestamptz, ${worker.worker_id})
      RETURNING tool_usage_id`);
    usageId = Number(rows[0].tool_usage_id);
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("상세는 필수 일곱 칸과 µs를 보존하고 과거 누계를 지어내지 않는다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/tool-usages/${usageId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body).toEqual({
      toolUsageId: usageId,
      moldId: expect.any(Number),
      moldCode: `${PREFIX}-MOLD`,
      workOrderId: expect.any(Number),
      shotCount: 1250,
      collectionMethodCode: "DIRECT",
      conversionBaseQty: null,
      conversionRatio: null,
      occurredAt: "2026-09-09T01:02:03.123456Z",
      recordedByWorkerNo: `${PREFIX}-WORKER`,
    });
    expect(response.body).not.toHaveProperty("cumulativeShotCount");
    expect(response.body).not.toHaveProperty("cumulativeAsOf");
  });

  it("없는 상세는 404다", async () => {
    await request(app.getHttpServer())
      .get("/api/maintenance/tool-usages/999999999")
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
    await prisma.tool_usage.deleteMany({ where: { mold: { mold_code: { startsWith: PREFIX } } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.mold.deleteMany({ where: { mold_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
