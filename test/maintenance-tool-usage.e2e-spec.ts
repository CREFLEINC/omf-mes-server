import { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { maintenanceInstantFromEpoch } from "../src/maintenance/maintenance-instant";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E_I33_TOOL";
const LOGIN_ID = `${PREFIX}-USER`;
const NO_PERMISSION_LOGIN_ID = `${PREFIX}-NO-PERM`;
const ROLE_CODE = `${PREFIX}-ROLE`;
const WORKER_NO = `${PREFIX}-WORKER`;
const PASSWORD = "I-33-툴-조회-검증-비밀번호";

describe("툴 사용실적 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermissionCookie: string[];
  let usageId: number;
  let moldId: number;
  let workOrderId: number;
  let actorUserId: number;

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
    actorUserId = Number(user.app_user_id);
    const noPermissionUser = await prisma.app_user.create({
      data: {
        login_id: NO_PERMISSION_LOGIN_ID,
        user_name: "I-33 툴 권한 없음",
        status_code: "EMPLOYED",
      },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: noPermissionUser.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const role = await prisma.role.create({
      data: { role_code: ROLE_CODE, role_name: "I-33 툴 입력" },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: "P-05-01" },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const worker = await prisma.worker.create({
      data: {
        worker_no: WORKER_NO,
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
    const rows = await prisma.$queryRaw<{ tool_usage_id: bigint; shot_count: bigint }[]>(Prisma.sql`
      INSERT INTO maintenance.tool_usage
        (mold_id, work_order_id, shot_count, collection_method_code,
         conversion_base_qty, conversion_ratio, occurred_at, recorded_by)
      VALUES
        (${mold.mold_id}, ${order.work_order_id}, 1250, 'DIRECT', NULL, NULL,
         '2026-09-09 08:02:03.123456+07'::timestamptz, ${worker.worker_id}),
        (${mold.mold_id}, ${order.work_order_id}, 25, 'CONVERTED', 100, 0.25,
         '2026-09-08 08:02:03.654321+07'::timestamptz, ${worker.worker_id})
      RETURNING tool_usage_id, shot_count`);
    usageId = Number(rows.find((row) => row.shot_count === 1250n)?.tool_usage_id);
    moldId = Number(mold.mold_id);
    workOrderId = Number(order.work_order_id);
    cookie = await login();
    noPermissionCookie = await login(NO_PERMISSION_LOGIN_ID);
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
      recordedByWorkerNo: WORKER_NO,
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

  it("목록은 발생시각 역순 페이지와 필터 전체 count를 함께 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/tool-usages?moldId=${moldId}&workOrderId=${workOrderId}&page=1&size=1`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].toolUsageId).toBe(usageId);
    expect(response.body.totalCount).toBe(2);
    expect(response.body.page).toEqual({ page: 1, size: 1, total: 2 });
  });

  it("목록 날짜는 금형 공장의 달력일 경계로 필터한다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/tool-usages?moldId=${moldId}&occurredFrom=2026-09-09&occurredTo=2026-09-09`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body.items.map((row: { toolUsageId: number }) => row.toolUsageId)).toEqual([
      usageId,
    ]);
    expect(response.body.totalCount).toBe(1);
  });

  it("DIRECT 증분과 후속 입력 뒤 재생은 최초 누계·기준시각을 그대로 보존한다", async () => {
    const before = await moldState();
    const beforeRows = await usageCount();
    const key = randomUUID();
    const body = createBody({ shotCount: 7, occurredAt: "2026-09-06T10:00:00.123456+07:00" });
    const first = await postUsage(body, key).expect(201);
    expect(first.body).toMatchObject({
      moldId,
      workOrderId,
      shotCount: 7,
      collectionMethodCode: "DIRECT",
      conversionBaseQty: null,
      conversionRatio: null,
      occurredAt: "2026-09-06T03:00:00.123456Z",
      recordedByWorkerNo: WORKER_NO,
      cumulativeShotCount: before.current_shot_count + 7,
      cumulativeAsOf: expect.stringMatching(/\.\d{6}Z$/),
    });
    const afterFirst = await moldState();
    expect(first.body.cumulativeAsOf).toBe(
      maintenanceInstantFromEpoch(afterFirst.updated_epoch).utcIso,
    );
    await postUsage(createBody({ shotCount: 2 }), randomUUID()).expect(201);
    const replay = await postUsage(body, key).expect(201);
    expect(replay.body).toEqual(first.body);
    await postUsage(body, key, cookie, `${WORKER_NO}-OTHER`).expect(409);

    const after = await moldState();
    expect(after).toMatchObject({
      current_shot_count: before.current_shot_count + 9,
      version_no: before.version_no + 2,
      updated_by: actorUserId,
    });
    expect(await usageCount()).toBe(beforeRows + 2);
    const detail = await request(app.getHttpServer())
      .get(`/api/maintenance/tool-usages/${first.body.toolUsageId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(detail.body).not.toHaveProperty("cumulativeShotCount");
    expect(detail.body).not.toHaveProperty("cumulativeAsOf");
  });

  it("CONVERTED는 제출 타발수와 비율을 재계산 없이 저장한다", async () => {
    const response = await postUsage(
      createBody({
        shotCount: 1,
        collectionMethodCode: "CONVERTED",
        conversionBaseQty: 1,
        conversionRatio: 1.2,
        occurredAt: "2026-09-07T00:00:00.654321000Z",
      }),
      randomUUID(),
    ).expect(201);
    expect(response.body).toMatchObject({
      shotCount: 1,
      collectionMethodCode: "CONVERTED",
      conversionBaseQty: 1,
      conversionRatio: 1.2,
      occurredAt: "2026-09-07T00:00:00.654321Z",
    });
    const stored = await prisma.tool_usage.findUniqueOrThrow({
      where: { tool_usage_id: BigInt(response.body.toolUsageId) },
    });
    expect(stored.shot_count).toBe(1n);
    expect(stored.conversion_base_qty?.toString()).toBe("1");
    expect(stored.conversion_ratio?.toString()).toBe("1.2");
  });

  it("헤더·참조·환산·권한 오류는 이력과 누계를 바꾸지 않는다", async () => {
    const before = await moldState();
    const beforeRows = await usageCount();
    await postUsage(createBody(), randomUUID(), cookie, null).expect(400);
    await postUsage(createBody(), randomUUID(), cookie, "UNKNOWN-WORKER").expect(400);
    await postUsage(createBody({ workOrderId: 999999999 }), randomUUID()).expect(400);
    await postUsage(
      createBody({
        collectionMethodCode: "CONVERTED",
        conversionBaseQty: 1,
        conversionRatio: 0.0000001,
      }),
      randomUUID(),
    ).expect(400);
    await postUsage(createBody(), randomUUID(), noPermissionCookie).expect(403);
    expect(await moldState()).toMatchObject({
      current_shot_count: before.current_shot_count,
      version_no: before.version_no,
    });
    expect(await usageCount()).toBe(beforeRows);
  });

  it("비활성 툴은 허용하지만 폐기 툴은 쓰기 없이 422다", async () => {
    await prisma.mold.update({ where: { mold_id: BigInt(moldId) }, data: { is_active: false } });
    await postUsage(createBody({ shotCount: 1 }), randomUUID()).expect(201);
    await prisma.mold.update({
      where: { mold_id: BigInt(moldId) },
      data: { status_code: "DISPOSED" },
    });
    const before = await moldState();
    const beforeRows = await usageCount();
    await postUsage(createBody(), randomUUID()).expect(422);
    expect(await moldState()).toMatchObject({
      current_shot_count: before.current_shot_count,
      version_no: before.version_no,
    });
    expect(await usageCount()).toBe(beforeRows);
    await prisma.mold.update({
      where: { mold_id: BigInt(moldId) },
      data: { status_code: "IN_USE", is_active: true },
    });
  });

  it("서로 다른 두 키의 동시 증분은 유실 없이 직렬 누계와 version을 만든다", async () => {
    const before = await moldState();
    const responses = await Promise.all([
      postUsage(createBody({ shotCount: 1 }), randomUUID()),
      postUsage(createBody({ shotCount: 1 }), randomUUID()),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(
      responses.map((response) => response.body.cumulativeShotCount).sort((a, b) => a - b),
    ).toEqual([before.current_shot_count + 1, before.current_shot_count + 2]);
    expect(await moldState()).toMatchObject({
      current_shot_count: before.current_shot_count + 2,
      version_no: before.version_no + 2,
    });
  });

  it("현재 누계와 요청의 합이 안전 범위를 넘으면 전건 쓰기 없이 400이다", async () => {
    const before = await moldState();
    const beforeRows = await usageCount();
    await prisma.mold.update({
      where: { mold_id: BigInt(moldId) },
      data: { current_shot_count: BigInt(Number.MAX_SAFE_INTEGER) },
    });
    await postUsage(createBody({ shotCount: 1 }), randomUUID()).expect(400);
    expect(await usageCount()).toBe(beforeRows);
    await prisma.mold.update({
      where: { mold_id: BigInt(moldId) },
      data: { current_shot_count: BigInt(before.current_shot_count) },
    });
  });

  function postUsage(
    body: object,
    key: string,
    authCookie = cookie,
    workerNo: string | null = WORKER_NO,
  ) {
    const result = request(app.getHttpServer())
      .post("/api/maintenance/tool-usages")
      .set("Cookie", authCookie)
      .set("Idempotency-Key", key);
    if (workerNo !== null) result.set("X-Worker-No", workerNo);
    return result.send(body);
  }

  function createBody(overrides: Record<string, unknown> = {}) {
    return {
      moldId,
      workOrderId,
      shotCount: 3,
      collectionMethodCode: "DIRECT",
      occurredAt: "2026-09-07T00:00:00.123456Z",
      ...overrides,
    };
  }

  async function moldState() {
    const [row] = await prisma.$queryRaw<
      { current_shot_count: bigint; version_no: number; updated_by: bigint | null; updated_epoch: string }[]
    >(Prisma.sql`
      SELECT current_shot_count, version_no, updated_by,
        (extract(epoch FROM updated_at) * 1000000)::numeric(30,0)::text AS updated_epoch
      FROM mdm.mold WHERE mold_id = ${moldId}`);
    return { ...row, current_shot_count: Number(row.current_shot_count), updated_by: Number(row.updated_by) };
  }

  function usageCount(): Promise<number> {
    return prisma.tool_usage.count({ where: { mold_id: BigInt(moldId) } });
  }

  async function login(loginId = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId, password: PASSWORD })
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
    const users = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: userIds } } });
    const role = await prisma.role.findUnique({ where: { role_code: ROLE_CODE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
  }
});
