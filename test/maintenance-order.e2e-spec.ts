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
import { MaintenanceOrderList } from "../src/maintenance/order/order-query.service";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I31-Q1";
const LOGIN_ID = `${PREFIX}-LOGIN`;
const ROLE = `${PREFIX}-ROLE`;
const PASSWORD = "I31-지시조회-검증-비밀번호";
const PATH = "/api/maintenance/orders";
const OVERLAP_ID = 831310001n;

function validator(path: string, method = "get"): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, "../contracts/equipment-05설비툴.json"),
      "utf8",
    ),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ["int64", "double"]) ajv.addFormat(format, true);
  ajv.addSchema(contract, "https://omf-mes.invalid/i31-contract");
  const pointer = path.replace(/~/g, "~0").replace(/\//g, "~1");
  return ajv.compile({
    $ref: `https://omf-mes.invalid/i31-contract#/paths/${pointer}/${method}/responses/200/content/application~1json/schema`,
  });
}

describe("보전 지시 I-31 Q1 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let plantId = 0n;
  let inspectionItemId = 0n;
  let actorId = 0n;
  const records: Record<string, bigint> = {};
  const listValidator = validator("/maintenance/orders");
  const detailValidator = validator("/maintenance/orders/{maintenanceOrderId}");
  const cancelValidator = validator(
    "/maintenance/orders/{maintenanceOrderId}:cancel",
    "post",
  );

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
  });

  afterAll(async () => {
    try {
      if (prisma) await cleanup();
    } finally {
      if (app) await app.close();
    }
  });

  it("E-Q01/E-Q03 상세 required·optional·item·trigger 전 필드와 version ETag를 반환한다", async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${records.full}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.headers.etag).toBe("7");
    expect(detailValidator(response.body)).toBe(true);
    expect(response.body).toEqual({
      maintenanceOrderId: Number(records.full),
      maintenanceOrderNo: `${PREFIX}-FULL`,
      targetTypeCode: "EQUIPMENT",
      targetId: Number(OVERLAP_ID),
      targetCode: `${PREFIX}-EQ`,
      maintenanceTypeCode: "CORRECTIVE",
      plannedDate: "2026-09-01",
      assigneeUserId: Number(actorId),
      statusCode: "ISSUED",
      items: [
        {
          orderItemId: expect.any(Number),
          itemName: `${PREFIX}-ITEM-CURRENT`,
          statusCode: "PLANNED",
          inspectionItemId: Number(inspectionItemId),
          sequenceNo: 1,
        },
      ],
      triggers: [
        {
          triggerTypeCode: "BREAKDOWN",
          sourceId: 9123,
          snapshotNote: null,
          shotCountAtDue: null,
          guaranteedShotCountAtDue: null,
        },
        {
          triggerTypeCode: "PM_DUE",
          sourceId: null,
          snapshotNote: "타발수 원문",
          pmDueAxisCode: "SHOT",
          shotCountAtDue: 2147483648,
          guaranteedShotCountAtDue: 3000000000,
        },
      ],
      baseDate: null,
      orderNote: "지시 원문",
      issuedByUserId: Number(actorId),
      issuedAt: "2026-09-01T01:02:03.000Z",
    });
    expect(response.body).not.toHaveProperty("versionNo");
  });

  it("E-Q04 type 없는 겹치는 targetId는 EQUIPMENT와 MOLD를 모두 반환한다", async () => {
    const both = await list({
      targetId: Number(OVERLAP_ID),
      plannedFrom: "2026-09-01",
      plannedTo: "2026-09-01",
    });
    expect(both.items.map((item) => item.targetTypeCode).sort()).toEqual([
      "EQUIPMENT",
      "MOLD",
    ]);
    expect(both.totalCount).toBe(2);
    expect(both.page.total).toBe(2);
    expect(
      (
        await list({
          targetTypeCode: "EQUIPMENT",
          targetId: Number(OVERLAP_ID),
          statusCode: "ISSUED",
        })
      ).items.every((item) => item.targetTypeCode === "EQUIPMENT"),
    ).toBe(true);
    expect(
      (
        await list({
          targetTypeCode: "MOLD",
          targetId: Number(OVERLAP_ID),
          statusCode: "ISSUED",
          maintenanceTypeCode: "PREVENTIVE",
        })
      ).items.map((item) => item.maintenanceOrderId),
    ).toEqual([Number(records.mold)]);
  });

  it("E-Q05/E-Q07 planned 양끝 포함과 ID 내림차순 페이지 경계가 결정적이다", async () => {
    const query = {
      statusCode: "ISSUED",
      plannedFrom: "2026-09-01",
      plannedTo: "2026-09-30",
    };
    const all = await list(query);
    expect(all.totalCount).toBe(4);
    expect(
      all.items.map((item) => item.maintenanceOrderId).slice(0, 2),
    ).toEqual([Number(records.tieSecond), Number(records.tieFirst)]);
    expect(all.items.map((item) => item.plannedDate)).toEqual([
      "2026-09-30",
      "2026-09-30",
      "2026-09-01",
      "2026-09-01",
    ]);
    expect(
      (await list({ ...query, page: 1, size: 1 })).items[0].maintenanceOrderId,
    ).toBe(Number(records.tieSecond));
    expect(
      (await list({ ...query, page: 2, size: 1 })).items[0].maintenanceOrderId,
    ).toBe(Number(records.tieFirst));
    expect((await list({ ...query, page: 0, size: 999 })).page).toEqual({
      page: 1,
      size: 200,
      total: 4,
    });
  });

  it("E-Q06 없는 상세·필터·역전·안전범위와 계약 형식 오류를 구분한다", async () => {
    await request(app.getHttpServer())
      .get(`${PATH}/831319999`)
      .set("Cookie", cookie)
      .expect(404);
    expect((await list({ statusCode: `${PREFIX}-NONE` })).items).toEqual([]);

    const reverse = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query({ plannedFrom: "2026-09-02", plannedTo: "2026-09-01" })
      .expect(400);
    expect(reverse.body.errors[0]).toMatchObject({
      field: "plannedTo",
      code: "RANGE",
    });
    for (const query of [
      { targetTypeCode: "TOOL" },
      { plannedFrom: "2026-02-30" },
      { page: "text" },
      { targetId: "9007199254740992" },
      { page: String(Number.MAX_SAFE_INTEGER), size: 200 },
    ]) {
      await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query(query)
        .expect(400);
    }
  });

  it("E-Q08 plannedDate 결손 구행은 상세·목록에서 생략하거나 현재값으로 꾸미지 않는다", async () => {
    for (const path of [`${PATH}/${records.legacy}`, PATH]) {
      const call = request(app.getHttpServer()).get(path).set("Cookie", cookie);
      if (path === PATH) call.query({ statusCode: `${PREFIX}-LEGACY` });
      const response = await call.expect(500);
      expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
    }
  });

  it("E-O17/E-O18 취소는 감사·version을 갱신하고 같은 키는 최초 200을 재생한다", async () => {
    const key = randomUUID();
    const first = await request(app.getHttpServer())
      .post(`${PATH}/${records.full}:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", key)
      .set("If-Match", "7")
      .expect(200);
    expect(cancelValidator(first.body)).toBe(true);
    expect(first.body).toMatchObject({
      maintenanceOrderId: Number(records.full),
      statusCode: "CANCELLED",
    });
    const stored = await prisma.maintenance_order.findUniqueOrThrow({
      where: { maintenance_order_id: records.full },
      include: {
        _count: {
          select: {
            maintenance_order_item: true,
            maintenance_order_trigger: true,
          },
        },
      },
    });
    expect(stored).toMatchObject({
      status_code: "CANCELLED",
      cancelled_by: actorId,
      updated_by: actorId,
      version_no: 8,
      _count: { maintenance_order_item: 1, maintenance_order_trigger: 2 },
    });
    expect(stored.cancelled_at).toBeInstanceOf(Date);

    const replay = await request(app.getHttpServer())
      .post(`${PATH}/${records.full}:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", key)
      .set("If-Match", "7")
      .expect(200);
    expect(replay.body).toEqual(first.body);

    const already = await request(app.getHttpServer())
      .post(`${PATH}/${records.full}:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .set("If-Match", "8")
      .expect(400);
    expect(already.body.errors[0].code).toBe("STATE_LOCKED");
  });

  it("E-O19/E-O20 stale·실적 존재·없는 지시를 각각 409·400·404로 가른다", async () => {
    const stale = await request(app.getHttpServer())
      .post(`${PATH}/${records.tieFirst}:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .set("If-Match", "2")
      .expect(409);
    expect(stale.body.conflictCause).toBe("user");

    await prisma.maintenance_result.create({
      data: {
        maintenance_order_id: records.tieSecond,
        target_type_code: "EQUIPMENT",
        equipment_id: OVERLAP_ID,
        started_at: new Date("2026-09-30T01:00:00Z"),
        result_note: `${PREFIX}-CANCEL-BLOCKER`,
        is_outsourced: false,
        reset_counter: false,
        closed: false,
        created_by: actorId,
      },
    });
    const referenced = await request(app.getHttpServer())
      .post(`${PATH}/${records.tieSecond}:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .set("If-Match", "1")
      .expect(400);
    expect(referenced.body.errors[0].code).toBe("STATE_LOCKED");

    await request(app.getHttpServer())
      .post(`${PATH}/831319999:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .set("If-Match", "1")
      .expect(404);
  });

  async function list(
    query: Record<string, unknown>,
  ): Promise<MaintenanceOrderList> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query(query)
      .expect(200);
    expect(listValidator(response.body)).toBe(true);
    return response.body as MaintenanceOrderList;
  }

  async function fixtures(): Promise<void> {
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
    plantId = (
      await prisma.plant.create({
        data: {
          plant_code: PREFIX,
          plant_name: PREFIX,
          legal_entity_id: legal.legal_entity_id,
          business_unit_id: business.business_unit_id,
          timezone_code: "Asia/Ho_Chi_Minh",
        },
      })
    ).plant_id;
    await prisma.$executeRaw`
      INSERT INTO mdm.equipment
        (equipment_id,equipment_code,equipment_name,equipment_type_code,status_code,plant_id)
      OVERRIDING SYSTEM VALUE
      VALUES (${OVERLAP_ID},${`${PREFIX}-EQ`},${PREFIX},'MACHINE','ACTIVE',${plantId})`;
    await prisma.$executeRaw`
      INSERT INTO mdm.mold
        (mold_id,mold_code,mold_name,status_code,tool_type_code,plant_id)
      OVERRIDING SYSTEM VALUE
      VALUES (${OVERLAP_ID},${`${PREFIX}-MOLD`},${PREFIX},'IN_SERVICE','MOLD',${plantId})`;
    inspectionItemId = (
      await prisma.equipment_inspection_item.create({
        data: {
          inspection_item_code: PREFIX,
          inspection_item_name: `${PREFIX}-ITEM-CURRENT`,
          data_type_code: "BOOLEAN",
          plant_id: plantId,
          inspection_type_code: "MAINTENANCE",
          judgment_method_code: "BOOLEAN",
          sequence_no: 1,
        },
      })
    ).equipment_inspection_item_id;
    actorId = await authFixture();
    records.full = (
      await prisma.maintenance_order.create({
        data: {
          maintenance_order_no: `${PREFIX}-FULL`,
          target_type_code: "EQUIPMENT",
          equipment_id: OVERLAP_ID,
          order_type_code: "CORRECTIVE",
          status_code: "ISSUED",
          planned_date: new Date("2026-09-01T00:00:00Z"),
          order_note: "지시 원문",
          assignee_user_id: actorId,
          issued_by: actorId,
          issued_at: new Date("2026-09-01T01:02:03Z"),
          version_no: 7,
          maintenance_order_item: {
            create: {
              sequence_no: 1,
              inspection_item_id: inspectionItemId,
              item_name: "옛 스냅샷명",
              status_code: "PLANNED",
            },
          },
          maintenance_order_trigger: {
            create: [
              {
                trigger_type_code: "BREAKDOWN",
                source_id: 9123n,
                created_at: new Date("2026-09-01T01:00:00Z"),
              },
              {
                trigger_type_code: "PM_DUE",
                snapshot_note: "타발수 원문",
                pm_due_axis_code: "SHOT",
                shot_count_at_due: 2147483648n,
                guaranteed_shot_count_at_due: 3000000000n,
                created_at: new Date("2026-09-01T02:00:00Z"),
              },
            ],
          },
        },
      })
    ).maintenance_order_id;
    records.mold = await simpleOrder("MOLD", "2026-09-01", "PREVENTIVE");
    records.tieFirst = await simpleOrder("TIE-1", "2026-09-30", "CORRECTIVE");
    records.tieSecond = await simpleOrder("TIE-2", "2026-09-30", "CORRECTIVE");
    records.outside = await simpleOrder("OUTSIDE", "2026-08-31", "CORRECTIVE");
    records.legacy = (
      await prisma.maintenance_order.create({
        data: {
          maintenance_order_no: `${PREFIX}-LEGACY`,
          target_type_code: "EQUIPMENT",
          equipment_id: OVERLAP_ID,
          order_type_code: "CORRECTIVE",
          status_code: `${PREFIX}-LEGACY`,
          planned_date: null,
        },
      })
    ).maintenance_order_id;
  }

  async function simpleOrder(
    suffix: string,
    plannedDate: string,
    maintenanceType: "CORRECTIVE" | "PREVENTIVE",
  ): Promise<bigint> {
    const mold = suffix === "MOLD";
    return (
      await prisma.maintenance_order.create({
        data: {
          maintenance_order_no: `${PREFIX}-${suffix}`,
          target_type_code: mold ? "MOLD" : "EQUIPMENT",
          equipment_id: mold ? null : OVERLAP_ID,
          mold_id: mold ? OVERLAP_ID : null,
          order_type_code: maintenanceType,
          status_code: "ISSUED",
          planned_date: new Date(`${plannedDate}T00:00:00Z`),
          base_date:
            maintenanceType === "PREVENTIVE" ? new Date("2026-08-01") : null,
          maintenance_order_item: mold
            ? {
                create: {
                  sequence_no: 1,
                  item_name: "금형 자유 항목",
                  status_code: "PLANNED",
                },
              }
            : undefined,
          maintenance_order_trigger: mold
            ? {
                create: {
                  trigger_type_code: "PM_DUE",
                  pm_due_axis_code: "DATE",
                },
              }
            : undefined,
        },
      })
    ).maintenance_order_id;
  }

  async function authFixture(): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: PREFIX, status_code: "EMPLOYED" },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: PREFIX },
    });
    await prisma.role_permission.createMany({
      data: [
        { role_id: role.role_id, permission_code: "W-05-03" },
        { role_id: role.role_id, permission_code: "W-05-02" },
      ],
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers["set-cookie"];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
    return user.app_user_id;
  }

  async function cleanup(): Promise<void> {
    const orders = await prisma.maintenance_order.findMany({
      where: { maintenance_order_no: { startsWith: PREFIX } },
      select: { maintenance_order_id: true },
    });
    const orderIds = orders.map((row) => row.maintenance_order_id);
    await prisma.maintenance_result.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order_trigger.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order_item.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.equipment_inspection_item.deleteMany({
      where: { inspection_item_code: PREFIX },
    });
    await prisma.mold.deleteMany({ where: { mold_code: `${PREFIX}-MOLD` } });
    await prisma.equipment.deleteMany({
      where: { equipment_code: `${PREFIX}-EQ` },
    });
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.user_role.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role_permission.deleteMany({
        where: { role_id: role.role_id },
      });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    const user = await prisma.app_user.findUnique({
      where: { login_id: LOGIN_ID },
    });
    if (user) {
      await prisma.idempotency_record.deleteMany({
        where: { app_user_id: user.app_user_id },
      });
      await prisma.user_credential.deleteMany({
        where: { app_user_id: user.app_user_id },
      });
      await prisma.app_user.delete({
        where: { app_user_id: user.app_user_id },
      });
    }
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
    expect(
      await prisma.maintenance_order.count({
        where: { maintenance_order_no: { startsWith: PREFIX } },
      }),
    ).toBe(0);
  }
});
