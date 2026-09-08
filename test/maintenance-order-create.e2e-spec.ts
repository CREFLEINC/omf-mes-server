import { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I31-W1";
const PATH = "/api/maintenance/orders";
const PASSWORD = "I31-지시발행-검증-비밀번호";

function responseValidator() {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, "../contracts/equipment-05설비툴.json"),
      "utf8",
    ),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ["int64", "double"]) ajv.addFormat(format, true);
  ajv.addSchema(contract, "https://omf-mes.invalid/i31-w1-contract");
  return ajv.compile({
    $ref: "https://omf-mes.invalid/i31-w1-contract#/paths/~1maintenance~1orders/post/responses/201/content/application~1json/schema",
  });
}

describe("보전 지시 I-31 W1 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermissionCookie: string[];
  let actorId = 0n;
  let plantId = 0n;
  let equipmentId = 0n;
  let groupedEquipmentId = 0n;
  let moldId = 0n;
  let itemA = 0n;
  let itemB = 0n;
  let parentGroupId = 0n;
  let childGroupId = 0n;
  let inspectionId = 0n;
  let breakdownIds: bigint[] = [];
  const validateCreated = responseValidator();

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

  it("E-O01/O02/O10/O11/O21/O22 설비 복수 원천을 201 원자 발행하고 같은 키는 재생한다", async () => {
    const key = randomUUID();
    const note = `${PREFIX}-EQUIPMENT`;
    const body = equipmentBody(equipmentId, itemA, note, [
      { triggerTypeCode: "BREAKDOWN", sourceId: Number(breakdownIds[0]) },
      { triggerTypeCode: "BREAKDOWN", sourceId: Number(breakdownIds[1]) },
      { triggerTypeCode: "INSPECTION_NG", sourceId: Number(inspectionId) },
    ]);
    const before = await sideEffects();

    const created = await post(body, key).expect(201);
    expect(validateCreated(created.body)).toBe(true);
    expect(created.body).toMatchObject({
      maintenanceOrderNo: expect.stringMatching(/^MO-20260910-\d{4,}$/),
      targetTypeCode: "EQUIPMENT",
      targetId: Number(equipmentId),
      targetCode: `${PREFIX}-EQ`,
      maintenanceTypeCode: "CORRECTIVE",
      plannedDate: "2026-09-10",
      assigneeUserId: Number(actorId),
      statusCode: "ISSUED",
      baseDate: null,
      orderNote: note,
      issuedByUserId: Number(actorId),
      issuedAt: expect.any(String),
      items: [
        {
          itemName: `${PREFIX}-ITEM-A`,
          statusCode: "PLANNED",
          inspectionItemId: Number(itemA),
          sequenceNo: 1,
        },
      ],
    });
    expect(
      created.body.triggers.map(
        (row: { triggerTypeCode: string }) => row.triggerTypeCode,
      ),
    ).toEqual(["BREAKDOWN", "BREAKDOWN", "INSPECTION_NG"]);
    expect(created.body).not.toHaveProperty("versionNo");

    const stored = await prisma.maintenance_order.findUniqueOrThrow({
      where: { maintenance_order_id: BigInt(created.body.maintenanceOrderId) },
      include: {
        maintenance_order_item: true,
        maintenance_order_trigger: true,
      },
    });
    expect(stored).toMatchObject({
      equipment_id: equipmentId,
      mold_id: null,
      breakdown_id: null,
      order_type_code: "CORRECTIVE",
      assigned_worker_id: null,
      priority_code: null,
      scheduled_start_at: null,
      scheduled_end_at: null,
      assignee_user_id: actorId,
      issued_by: actorId,
      created_by: actorId,
      updated_by: actorId,
      status_code: "ISSUED",
      version_no: 1,
    });
    expect(stored.maintenance_order_item).toHaveLength(1);
    expect(stored.maintenance_order_trigger).toHaveLength(3);
    expect(await sideEffects()).toEqual(before);

    const replay = await post(body, key).expect(201);
    expect(replay.body).toEqual(created.body);
    expect(
      await prisma.maintenance_order.count({ where: { order_note: note } }),
    ).toBe(1);
    const changed = await post(
      { ...body, orderNote: `${note}-CHANGED` },
      key,
    ).expect(409);
    expect(changed.body.conflictCause).toBe("user");

    const breakdowns = await request(app.getHttpServer())
      .get("/api/maintenance/breakdowns")
      .set("Cookie", cookie)
      .query({
        equipmentId: Number(equipmentId),
        withoutMaintenanceOrder: true,
      })
      .expect(200);
    expect(breakdowns.body.items).toEqual([]);
    const inspections = await request(app.getHttpServer())
      .get("/api/maintenance/inspections")
      .set("Cookie", cookie)
      .query({
        equipmentId: Number(equipmentId),
        withoutMaintenanceOrder: true,
      })
      .expect(200);
    expect(inspections.body.items).toEqual([]);
  });

  it("E-O08/O24/R26 잘못된 원천은 전건 롤백하고 헤더·권한 게이트를 지킨다", async () => {
    const key = randomUUID();
    const note = `${PREFIX}-INVALID`;
    const body = equipmentBody(equipmentId, itemA, note, [
      { triggerTypeCode: "BREAKDOWN", sourceId: 9_999_999 },
    ]);

    const invalid = await post(body, key).expect(400);
    expect(invalid.body.errors[0]).toMatchObject({
      field: "triggers[0].sourceId",
      code: "INVALID",
    });
    expect(
      await prisma.maintenance_order.count({ where: { order_note: note } }),
    ).toBe(0);
    expect(
      await prisma.idempotency_record.count({
        where: { idempotency_key: key },
      }),
    ).toBe(0);

    await request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .send(body)
      .expect(400);
    await request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", noPermissionCookie)
      .set("Idempotency-Key", randomUUID())
      .send(body)
      .expect(403);
  });

  it("E-O05/O13/O14/O15 금형 자유 항목과 생략 snapshot을 보존하고 열린 PM을 막는다", async () => {
    const note = `${PREFIX}-MOLD`;
    const body = {
      targetTypeCode: "MOLD",
      targetId: Number(moldId),
      plannedDate: "2026-09-11",
      assigneeUserId: Number(actorId),
      itemNames: [" 분해 청소 "],
      triggers: [{ triggerTypeCode: "PM_DUE" }],
      baseDate: "2026-09-01",
      orderNote: note,
    };

    const created = await post(body, randomUUID()).expect(201);
    expect(validateCreated(created.body)).toBe(true);
    expect(created.body).toMatchObject({
      targetTypeCode: "MOLD",
      targetId: Number(moldId),
      maintenanceTypeCode: "PREVENTIVE",
      items: [
        {
          itemName: " 분해 청소 ",
          inspectionItemId: null,
          statusCode: "PLANNED",
        },
      ],
      triggers: [
        {
          triggerTypeCode: "PM_DUE",
          sourceId: null,
          shotCountAtDue: null,
          guaranteedShotCountAtDue: null,
        },
      ],
      baseDate: "2026-09-01",
    });
    expect(created.body.triggers[0]).not.toHaveProperty("pmDueAxisCode");

    const duplicateKey = randomUUID();
    await post(body, duplicateKey).expect(422);
    expect(
      await prisma.maintenance_order.count({ where: { order_note: note } }),
    ).toBe(1);
    expect(
      await prisma.idempotency_record.count({
        where: { idempotency_key: duplicateKey },
      }),
    ).toBe(0);
  });

  it("E-O25 직접 부여 교체 writer와 target 잠금이 역대기 없이 최종 부여를 사용한다", async () => {
    const barrier = await holdRow((tx) =>
      tx.$queryRaw(Prisma.sql`
        SELECT equipment_id FROM mdm.equipment
        WHERE equipment_id=${equipmentId} FOR UPDATE`),
    );
    let writer: Promise<request.Response> | undefined;
    let create: Promise<request.Response> | undefined;
    try {
      writer = request(app.getHttpServer())
        .put(`/api/mdm/equipments/${equipmentId}/inspection-items`)
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .set("If-Match", "1")
        .send({ items: [assignmentBody(itemB)] })
        .expect(200)
        .then((response) => response);
      await waitForBlocked(
        (query) => query.includes("UPDATE") && query.includes("equipment"),
      );

      create = post(
        equipmentPmBody(
          equipmentId,
          itemB,
          `${PREFIX}-DIRECT-RACE`,
          "2026-09-12",
        ),
        randomUUID(),
      )
        .expect(201)
        .then((response) => response);
      await waitForBlocked(
        (query) =>
          query.includes("FROM mdm.equipment") &&
          query.includes("FOR NO KEY UPDATE"),
      );
      barrier.release();
      const [, created] = await Promise.all([writer, create]);
      expect(created.body.items[0].inspectionItemId).toBe(Number(itemB));
    } finally {
      barrier.release();
      await barrier.done;
      await Promise.allSettled([writer, create].filter(Boolean));
    }
  });

  it("E-O26/O29/O30 빈 중간층 writer 뒤 경로를 동일 번호로 재해석한다", async () => {
    const before = await counterValue("2026-09-13");
    const barrier = await holdRow((tx) =>
      tx.$queryRaw(Prisma.sql`
        SELECT production_line_id FROM mdm.production_line
        WHERE production_line_id=${childGroupId} FOR UPDATE`),
    );
    let writer: Promise<request.Response> | undefined;
    let create: Promise<request.Response> | undefined;
    try {
      writer = request(app.getHttpServer())
        .put(`/api/mdm/equipment-groups/${childGroupId}/inspection-items`)
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .set("If-Match", "1")
        .send({ items: [assignmentBody(itemB)] })
        .expect(200)
        .then((response) => response);
      await waitForBlocked(
        (query) =>
          query.includes("UPDATE") && query.includes("production_line"),
      );

      create = post(
        equipmentPmBody(
          groupedEquipmentId,
          itemB,
          `${PREFIX}-PATH-RACE`,
          "2026-09-13",
        ),
        randomUUID(),
      )
        .expect(201)
        .then((response) => response);
      await waitForBlocked(
        (query) =>
          query.includes("SELECT production_line_id") &&
          query.includes("FOR SHARE"),
      );
      barrier.release();
      const [, created] = await Promise.all([writer, create]);
      expect(created.body.items[0].inspectionItemId).toBe(Number(itemB));
      expect(await counterValue("2026-09-13")).toBe(before + 1n);
      expect(
        await prisma.maintenance_order.count({
          where: { order_note: `${PREFIX}-PATH-RACE` },
        }),
      ).toBe(1);
    } finally {
      barrier.release();
      await barrier.done;
      await Promise.allSettled([writer, create].filter(Boolean));
    }
  });

  it("E-O27 항목 비활성 writer가 먼저면 SHARE 이후 최종 상태로 발행을 거부한다", async () => {
    const key = randomUUID();
    const note = `${PREFIX}-ITEM-RACE`;
    const barrier = await holdRow((tx) =>
      tx.$queryRaw(Prisma.sql`
        SELECT equipment_inspection_item_id FROM mdm.equipment_inspection_item
        WHERE equipment_inspection_item_id=${itemB} FOR UPDATE`),
    );
    let writer: Promise<request.Response> | undefined;
    let create: Promise<request.Response> | undefined;
    try {
      writer = request(app.getHttpServer())
        .put(`/api/mdm/equipment-inspection-items/${itemB}`)
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .set("If-Match", "1")
        .send({
          itemCode: `${PREFIX}-ITEM-B`,
          itemName: `${PREFIX}-ITEM-B`,
          inspectionTypeCode: "MAINTENANCE",
          judgmentMethodCode: "VISUAL",
          requiredFlag: true,
          sequenceNo: 2,
          isActive: false,
        })
        .expect(200)
        .then((response) => response);
      await waitForBlocked(
        (query) =>
          query.includes("UPDATE") &&
          query.includes("equipment_inspection_item"),
      );

      create = post(
        equipmentPmBody(groupedEquipmentId, itemB, note, "2026-09-14"),
        key,
      )
        .expect(400)
        .then((response) => response);
      await waitForBlocked(
        (query) =>
          query.includes("FROM mdm.equipment_inspection_item") &&
          query.includes("FOR SHARE"),
      );
      barrier.release();
      const [, rejected] = await Promise.all([writer, create]);
      expect(rejected.body.errors[0]).toMatchObject({
        field: "items[0].inspectionItemId",
        code: "INVALID",
      });
      expect(
        await prisma.maintenance_order.count({ where: { order_note: note } }),
      ).toBe(0);
      expect(
        await prisma.idempotency_record.count({
          where: { idempotency_key: key },
        }),
      ).toBe(0);
    } finally {
      barrier.release();
      await barrier.done;
      await Promise.allSettled([writer, create].filter(Boolean));
    }
  });

  function post(body: object, key: string) {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", key)
      .send(body);
  }

  function equipmentBody(
    targetId: bigint,
    inspectionItemId: bigint,
    orderNote: string,
    triggers: object[],
  ) {
    return {
      targetTypeCode: "EQUIPMENT",
      targetId: Number(targetId),
      plannedDate: "2026-09-10",
      assigneeUserId: Number(actorId),
      items: [{ sequenceNo: 1, inspectionItemId: Number(inspectionItemId) }],
      triggers,
      baseDate: triggers.some(
        (trigger) =>
          (trigger as { triggerTypeCode: string }).triggerTypeCode ===
          "BREAKDOWN",
      )
        ? null
        : "2026-09-01",
      orderNote,
    };
  }

  function equipmentPmBody(
    targetId: bigint,
    inspectionItemId: bigint,
    orderNote: string,
    plannedDate: string,
  ) {
    return {
      ...equipmentBody(targetId, inspectionItemId, orderNote, [
        { triggerTypeCode: "PM_DUE" },
      ]),
      plannedDate,
    };
  }

  function assignmentBody(inspectionItemId: bigint) {
    return {
      equipmentInspectionItemId: Number(inspectionItemId),
      isActive: true,
      cycleTypeCode: "DAY",
      cycleInterval: 1,
      cycleBaseDate: "2026-09-01",
    };
  }

  async function sideEffects() {
    const [notifications, downtimes, workOrders, inventory] = await Promise.all(
      [
        prisma.notification_event.count(),
        prisma.equipment_downtime.count({
          where: { equipment_id: equipmentId },
        }),
        prisma.work_order.count({
          where: { planned_equipment_id: equipmentId },
        }),
        prisma.inventory_transaction.count({
          where: { source_document_type_code: "MAINTENANCE_ORDER" },
        }),
      ],
    );
    return { notifications, downtimes, workOrders, inventory };
  }

  async function counterValue(day: string): Promise<bigint> {
    const rows = await prisma.$queryRaw<{ value: bigint }[]>(Prisma.sql`
      SELECT COALESCE(sum(c.last_value),0)::bigint AS value
      FROM app.numbering_counter c
      JOIN app.numbering_rule r ON r.numbering_rule_id=c.numbering_rule_id
      WHERE r.document_type_code='MAINTENANCE_ORDER'
        AND c.period_key=${day.replace(/-/g, "")}
        AND (r.plant_id=${plantId} OR r.plant_id IS NULL)`);
    return rows[0].value;
  }

  async function holdRow(
    lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<{ release: () => void; done: Promise<unknown> }> {
    let ready!: () => void;
    let release!: () => void;
    let released = false;
    const readyPromise = new Promise<void>((resolve) => (ready = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    const done = prisma.$transaction(async (tx) => {
      await lock(tx);
      ready();
      await releasePromise;
    });
    await readyPromise;
    return {
      release: () => {
        if (released) return;
        released = true;
        release();
      },
      done,
    };
  }

  async function waitForBlocked(
    matches: (query: string) => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const rows = await prisma.$queryRaw<{ query: string }[]>`
        SELECT query FROM pg_stat_activity
        WHERE datname=current_database()
          AND pid<>pg_backend_pid()
          AND wait_event_type='Lock'`;
      if (rows.some((row) => matches(row.query))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("제어한 DB 잠금 대기를 관찰하지 못했습니다.");
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
    const parent = await prisma.production_line.create({
      data: {
        plant_id: plantId,
        line_code: `${PREFIX}-PARENT`,
        line_name: `${PREFIX}-PARENT`,
        line_type_code: "LINE",
      },
    });
    parentGroupId = parent.production_line_id;
    childGroupId = (
      await prisma.production_line.create({
        data: {
          plant_id: plantId,
          parent_line_id: parentGroupId,
          line_code: `${PREFIX}-CHILD`,
          line_name: `${PREFIX}-CHILD`,
          line_type_code: "LINE",
        },
      })
    ).production_line_id;
    equipmentId = (
      await prisma.equipment.create({
        data: {
          plant_id: plantId,
          equipment_code: `${PREFIX}-EQ`,
          equipment_name: `${PREFIX}-EQ`,
          equipment_type_code: "MACHINE",
          status_code: "IN_SERVICE",
        },
      })
    ).equipment_id;
    groupedEquipmentId = (
      await prisma.equipment.create({
        data: {
          plant_id: plantId,
          production_line_id: childGroupId,
          equipment_code: `${PREFIX}-GROUP-EQ`,
          equipment_name: `${PREFIX}-GROUP-EQ`,
          equipment_type_code: "MACHINE",
          status_code: "IN_SERVICE",
        },
      })
    ).equipment_id;
    itemA = await inspectionItem("A", 1);
    itemB = await inspectionItem("B", 2);
    await prisma.equipment_inspection_item_assignment.create({
      data: {
        equipment_id: equipmentId,
        equipment_inspection_item_id: itemA,
        cycle_type_code: "DAY",
        cycle_interval: 1,
      },
    });
    await prisma.equipment_group_inspection_item.create({
      data: {
        production_line_id: parentGroupId,
        equipment_inspection_item_id: itemA,
        cycle_type_code: "DAY",
        cycle_interval: 1,
      },
    });
    breakdownIds = (
      await Promise.all(
        ["RECEIVED", "HANDLING"].map((status, index) =>
          prisma.breakdown.create({
            data: {
              breakdown_no: `${PREFIX}-BD-${index + 1}`,
              equipment_id: equipmentId,
              reported_at: new Date("2026-09-08T00:00:00Z"),
              description: `${PREFIX}-BD-${index + 1}`,
              status_code: status,
            },
          }),
        ),
      )
    ).map((row) => row.breakdown_id);
    inspectionId = (
      await prisma.equipment_inspection.create({
        data: {
          inspection_no: `${PREFIX}-INSPECTION`,
          equipment_id: equipmentId,
          inspection_type_code: "DAILY",
          inspected_at: new Date("2026-09-08T00:00:00Z"),
          judgment_code: "FAIL",
        },
      })
    ).equipment_inspection_id;
    moldId = (
      await prisma.mold.create({
        data: {
          plant_id: plantId,
          mold_code: `${PREFIX}-MOLD`,
          mold_name: `${PREFIX}-MOLD`,
          status_code: "IN_SERVICE",
          tool_type_code: "MOLD",
          pm_trigger_type_code: "SHOT",
          guaranteed_shot_count: 100n,
          current_shot_count: 100n,
        },
      })
    ).mold_id;
    const actor = await authFixture("ACTOR", ["W-05-02", "W-05-12"]);
    actorId = actor.appUserId;
    cookie = actor.cookie;
    noPermissionCookie = (await authFixture("NO-PERMISSION", [])).cookie;
  }

  async function inspectionItem(
    suffix: string,
    sequenceNo: number,
  ): Promise<bigint> {
    return (
      await prisma.equipment_inspection_item.create({
        data: {
          plant_id: plantId,
          inspection_item_code: `${PREFIX}-ITEM-${suffix}`,
          inspection_item_name: `${PREFIX}-ITEM-${suffix}`,
          data_type_code: "BOOLEAN",
          inspection_type_code: "MAINTENANCE",
          judgment_method_code: "BOOLEAN",
          sequence_no: sequenceNo,
        },
      })
    ).equipment_inspection_item_id;
  }

  async function authFixture(
    suffix: string,
    permissions: string[],
  ): Promise<{ appUserId: bigint; cookie: string[] }> {
    const loginId = `${PREFIX}-${suffix}`;
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: loginId, status_code: "EMPLOYED" },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    const role = await prisma.role.create({
      data: { role_code: loginId, role_name: loginId },
    });
    if (permissions.length) {
      await prisma.role_permission.createMany({
        data: permissions.map((permission_code) => ({
          role_id: role.role_id,
          permission_code,
        })),
      });
    }
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers["set-cookie"];
    return {
      appUserId: user.app_user_id,
      cookie: Array.isArray(raw) ? (raw as string[]) : [String(raw)],
    };
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const userIds = users.map((row) => row.app_user_id);
    const equipments = await prisma.equipment.findMany({
      where: { equipment_code: { startsWith: PREFIX } },
      select: { equipment_id: true },
    });
    const equipmentIds = equipments.map((row) => row.equipment_id);
    const molds = await prisma.mold.findMany({
      where: { mold_code: { startsWith: PREFIX } },
      select: { mold_id: true },
    });
    const moldIds = molds.map((row) => row.mold_id);
    const orders = await prisma.maintenance_order.findMany({
      where: {
        OR: [
          { order_note: { startsWith: PREFIX } },
          { equipment_id: { in: equipmentIds } },
          { mold_id: { in: moldIds } },
        ],
      },
      select: { maintenance_order_id: true },
    });
    const orderIds = orders.map((row) => row.maintenance_order_id);
    const results = await prisma.maintenance_result.findMany({
      where: { maintenance_order_id: { in: orderIds } },
      select: { maintenance_result_id: true },
    });
    const resultIds = results.map((row) => row.maintenance_result_id);
    await prisma.maintenance_result_part.deleteMany({
      where: { maintenance_result_id: { in: resultIds } },
    });
    await prisma.maintenance_result_line.deleteMany({
      where: { maintenance_result_id: { in: resultIds } },
    });
    await prisma.maintenance_result.deleteMany({
      where: { maintenance_result_id: { in: resultIds } },
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
    await prisma.idempotency_record.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.equipment_inspection_result.deleteMany({
      where: {
        equipment_inspection: { inspection_no: { startsWith: PREFIX } },
      },
    });
    await prisma.equipment_inspection.deleteMany({
      where: { inspection_no: { startsWith: PREFIX } },
    });
    await prisma.breakdown.deleteMany({
      where: { breakdown_no: { startsWith: PREFIX } },
    });
    await prisma.equipment_inspection_item_assignment.deleteMany({
      where: { equipment_id: { in: equipmentIds } },
    });
    await prisma.equipment_group_inspection_item.deleteMany({
      where: { production_line: { line_code: { startsWith: PREFIX } } },
    });
    await prisma.equipment.deleteMany({
      where: { equipment_id: { in: equipmentIds } },
    });
    await prisma.equipment_inspection_item.deleteMany({
      where: { inspection_item_code: { startsWith: PREFIX } },
    });
    await prisma.mold.deleteMany({ where: { mold_id: { in: moldIds } } });
    await prisma.production_line.deleteMany({
      where: { line_code: `${PREFIX}-CHILD` },
    });
    await prisma.production_line.deleteMany({
      where: { line_code: `${PREFIX}-PARENT` },
    });
    const roles = await prisma.role.findMany({
      where: { role_code: { startsWith: PREFIX } },
      select: { role_id: true },
    });
    const roleIds = roles.map((row) => row.role_id);
    await prisma.user_role.deleteMany({
      where: {
        OR: [{ role_id: { in: roleIds } }, { app_user_id: { in: userIds } }],
      },
    });
    await prisma.role_permission.deleteMany({
      where: { role_id: { in: roleIds } },
    });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.user_credential.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.app_user.deleteMany({
      where: { app_user_id: { in: userIds } },
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
