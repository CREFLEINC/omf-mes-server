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

const PREFIX = "E2E-B-I31-W2";
const PASSWORD = "I31-실적등록-검증-비밀번호";
const PATH = "/api/maintenance/results";
const RESULT_CODE = `${PREFIX}-CUSTOM`;

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
  ajv.addSchema(contract, "https://omf-mes.invalid/i31-w2-contract");
  return ajv.compile({
    $ref: "https://omf-mes.invalid/i31-w2-contract#/paths/~1maintenance~1results/post/responses/201/content/application~1json/schema",
  });
}

describe("보전 실적 I-31 W2 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let secondCookie: string[];
  let noPermissionCookie: string[];
  let actorId = 0n;
  let performerId = 0n;
  let plantId = 0n;
  let equipmentId = 0n;
  let otherEquipmentId = 0n;
  let moldId = 0n;
  let breakdownId = 0n;
  let inspectionItemId = 0n;
  let sparePartId = 0n;
  let goodsIssueId = 0n;
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

  it("E-R01/04/06/08/09/12/17/19/27/30 지시 실적을 원자 등록하고 같은 키를 재생한다", async () => {
    const { orderId, itemId } = await equipmentOrder("SUCCESS");
    const key = randomUUID();
    const note = `${PREFIX}-SUCCESS`;
    const body = equipmentBody(orderId, itemId, note);
    const before = await forbiddenSideEffects();

    const created = await post(body, key).expect(201);
    expect(validateCreated(created.body)).toBe(true);
    expect(created.body).toMatchObject({
      maintenanceOrderId: Number(orderId),
      breakdownId: null,
      targetTypeCode: "EQUIPMENT",
      targetId: Number(equipmentId),
      startedAt: "2026-09-01T00:00:00.123456Z",
      finishedAt: "2026-09-01T01:00:00.654321Z",
      resultNote: note,
      performedByUserId: Number(performerId),
      isOutsourced: false,
      outsourceVendorName: null,
      resetCounter: false,
      shotCountBeforeReset: null,
      shotCountAfterReset: null,
      closed: false,
      lines: [
        {
          orderItemId: Number(itemId),
          partName: null,
          resultCode: RESULT_CODE,
          remarks: "원문 비고",
        },
      ],
      parts: [
        {
          sparePartId: Number(sparePartId),
          partName: "입력 이름",
          usedQty: 2.5,
          goodsIssueId: Number(goodsIssueId),
          goodsIssueNo: `${PREFIX}-GI`,
          issuedAt: "2026-08-14T02:12:00.111222Z",
          uomCode: `${PREFIX}-EA`,
        },
      ],
    });
    expect(created.body).not.toHaveProperty("versionNo");

    const resultId = BigInt(created.body.maintenanceResultId);
    const stored = await prisma.maintenance_result.findUniqueOrThrow({
      where: { maintenance_result_id: resultId },
      include: { maintenance_result_line: true, maintenance_result_part: true },
    });
    expect(stored).toMatchObject({
      maintenance_order_id: orderId,
      result_seq: null,
      action_code: null,
      action_description: null,
      performed_by: null,
      result_code: null,
      equipment_id: equipmentId,
      mold_id: null,
      result_note: note,
      performed_by_user_id: performerId,
      is_outsourced: false,
      reset_counter: false,
      shot_count_before_reset: null,
      shot_count_after_reset: null,
      closed: false,
      version_no: 1,
      created_by: actorId,
      updated_by: actorId,
    });
    expect(stored.maintenance_result_line).toHaveLength(1);
    expect(stored.maintenance_result_part[0].part_name).toBe("입력 이름");
    const epochs = await prisma.$queryRaw<
      { started: string; completed: string }[]
    >`
      SELECT (extract(epoch FROM started_at)*1000000)::numeric(30,0)::text AS started,
             (extract(epoch FROM completed_at)*1000000)::numeric(30,0)::text AS completed
      FROM maintenance.maintenance_result WHERE maintenance_result_id=${resultId}`;
    expect(epochs[0]).toEqual({
      started: "1788220800123456",
      completed: "1788224400654321",
    });
    const order = await prisma.maintenance_order.findUniqueOrThrow({
      where: { maintenance_order_id: orderId },
      include: { maintenance_order_item: true },
    });
    expect(order.status_code).toBe("ISSUED");
    expect(order.maintenance_order_item[0].status_code).toBe("PLANNED");
    expect(await forbiddenSideEffects()).toEqual(before);

    const replay = await post(body, key).expect(201);
    expect(replay.body).toEqual(created.body);
    expect(
      await prisma.maintenance_result.count({ where: { result_note: note } }),
    ).toBe(1);
    const changed = await post(
      { ...body, resultNote: `${note}-CHANGED` },
      key,
    ).expect(409);
    expect(changed.body.conflictCause).toBe("user");
    const otherActor = await post(body, key, secondCookie).expect(409);
    expect(otherActor.body.conflictCause).toBe("user");

    const second = await post(body, randomUUID()).expect(201);
    expect(second.body.maintenanceResultId).not.toBe(
      created.body.maintenanceResultId,
    );
    expect(
      await prisma.maintenance_result.count({
        where: { maintenance_order_id: orderId },
      }),
    ).toBe(2);
  });

  it("E-R02 지시 없는 설비 실적은 같은 설비의 고장을 직접 연결한다", async () => {
    const note = `${PREFIX}-DIRECT`;
    const body = {
      targetTypeCode: "EQUIPMENT",
      targetId: Number(equipmentId),
      breakdownId: Number(breakdownId),
      startedAt: "2026-09-02T00:00:00Z",
      resultNote: note,
      performedByUserId: Number(performerId),
      lines: [{ resultCode: RESULT_CODE }],
    };
    const created = await post(body, randomUUID()).expect(201);
    expect(created.body).toMatchObject({
      maintenanceOrderId: null,
      breakdownId: Number(breakdownId),
      targetId: Number(equipmentId),
      finishedAt: null,
      closed: false,
    });
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: breakdownId },
      }),
    ).toMatchObject({ status_code: "RECEIVED" });

    await post(
      {
        ...body,
        targetId: Number(otherEquipmentId),
        resultNote: `${note}-BAD`,
      },
      randomUUID(),
    ).expect(400);
    await post(
      { ...body, breakdownId: null, resultNote: `${note}-NONE` },
      randomUUID(),
    ).expect(400);
  });

  it("E-R03/22/28/31 폐기 금형 non-reset은 허용하고 reset·closed·ETag 오류는 전건 거부한다", async () => {
    const orderId = await moldOrder("MOLD");
    await prisma.mold.update({
      where: { mold_id: moldId },
      data: { status_code: "DISPOSED", is_active: false },
    });
    const before = await prisma.mold.findUniqueOrThrow({
      where: { mold_id: moldId },
    });
    const body = {
      targetTypeCode: "MOLD",
      targetId: Number(moldId),
      maintenanceOrderId: Number(orderId),
      startedAt: "2026-09-03T00:00:00Z",
      resultNote: `${PREFIX}-MOLD`,
      isOutsourced: true,
      outsourceVendorName: " 외주 원문 ",
      lines: [{ partName: " 게이트 ", resultCode: RESULT_CODE }],
    };
    const created = await post(body, randomUUID())
      .set("If-Match", String(before.version_no))
      .expect(201);
    expect(created.body).toMatchObject({
      targetTypeCode: "MOLD",
      targetId: Number(moldId),
      performedByUserId: null,
      isOutsourced: true,
      outsourceVendorName: " 외주 원문 ",
      lines: [{ partName: " 게이트 ", resultCode: RESULT_CODE }],
    });
    const after = await prisma.mold.findUniqueOrThrow({
      where: { mold_id: moldId },
    });
    expect(after.current_shot_count).toBe(before.current_shot_count);
    expect(after.last_pm_date).toEqual(before.last_pm_date);
    expect(after.version_no).toBe(before.version_no);

    const noHeaderOrder = await moldOrder("MOLD-NO-HEADER");
    await post(
      {
        ...body,
        maintenanceOrderId: Number(noHeaderOrder),
        resultNote: `${PREFIX}-MOLD-NO-HEADER`,
      },
      randomUUID(),
    ).expect(201);
    const staleOrder = await moldOrder("MOLD-STALE");
    await post(
      {
        ...body,
        maintenanceOrderId: Number(staleOrder),
        resultNote: `${PREFIX}-MOLD-STALE`,
      },
      randomUUID(),
    )
      .set("If-Match", String(before.version_no + 1))
      .expect(409);

    for (const [change, field] of [
      [{ resetCounter: true, shotCountAfterReset: 0 }, "resetCounter"],
      [{ closed: true }, "closed"],
    ] as const) {
      const key = randomUUID();
      const rejected = await post(
        { ...body, ...change, resultNote: `${PREFIX}-${field}` },
        key,
      ).expect(422);
      expect(rejected.body.errors[0]).toMatchObject({ field, code: "INVALID" });
      expect(
        await prisma.idempotency_record.count({
          where: { idempotency_key: key },
        }),
      ).toBe(0);
    }

    const { orderId: equipmentOrderId, itemId } =
      await equipmentOrder("IF-MATCH");
    await post(
      equipmentBody(equipmentOrderId, itemId, `${PREFIX}-EQ-IF-MATCH`),
      randomUUID(),
    )
      .set("If-Match", "1")
      .expect(400);
  });

  it("E-R05/07/10/11 참조·짝·수량 실패는 header/child/멱등행을 남기지 않는다", async () => {
    const { orderId, itemId } = await equipmentOrder("INVALID");
    const base = equipmentBody(orderId, itemId, `${PREFIX}-INVALID`);
    const cases: Array<[object, string]> = [
      [{ ...base, performedByUserId: null }, "performedByUserId"],
      [
        {
          ...base,
          isOutsourced: true,
          outsourceVendorName: "외주",
          performedByUserId: Number(performerId),
        },
        "performedByUserId",
      ],
      [
        {
          ...base,
          lines: [{ orderItemId: 9_999_999, resultCode: RESULT_CODE }],
        },
        "lines",
      ],
      [
        {
          ...base,
          parts: [{ sparePartId: Number(sparePartId), usedQty: 0.0000001 }],
        },
        "parts[0].usedQty",
      ],
      [
        {
          ...base,
          parts: [
            {
              sparePartId: Number(sparePartId),
              usedQty: 1,
              goodsIssueId: 9_999_999,
            },
          ],
        },
        "parts",
      ],
    ];
    for (const [body, field] of cases) {
      const key = randomUUID();
      const rejected = await post(body, key).expect(400);
      expect(rejected.body.errors[0].field).toBe(field);
      expect(
        await prisma.idempotency_record.count({
          where: { idempotency_key: key },
        }),
      ).toBe(0);
    }
    expect(
      await prisma.maintenance_result.count({
        where: { result_note: `${PREFIX}-INVALID` },
      }),
    ).toBe(0);
  });

  it("E-O18 취소와 등록 경합은 먼저 order 잠금을 얻은 요청만 성공한다", async () => {
    const first = await equipmentOrder("RACE-CANCEL-FIRST");
    const barrier = await holdRow((tx) =>
      tx.$queryRaw(Prisma.sql`
        SELECT maintenance_order_id FROM maintenance.maintenance_order
        WHERE maintenance_order_id=${first.orderId} FOR UPDATE`),
    );
    let cancel: Promise<request.Response> | undefined;
    let create: Promise<request.Response> | undefined;
    try {
      cancel = request(app.getHttpServer())
        .post(`/api/maintenance/orders/${first.orderId}:cancel`)
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .set("If-Match", "1")
        .send({})
        .then((response) => response);
      await waitForBlocked((query) => query.includes("maintenance_order"));
      create = post(
        equipmentBody(
          first.orderId,
          first.itemId,
          `${PREFIX}-RACE-CANCEL-FIRST`,
        ),
        randomUUID(),
      ).then((response) => response);
      await waitForBlocked((query) => query.includes("maintenance_order"), 2);
      barrier.release();
      const [cancelled, rejected] = await Promise.all([cancel, create]);
      expect(cancelled.status).toBe(200);
      expect(rejected.status).toBe(400);
    } finally {
      barrier.release();
      await barrier.done;
      await Promise.allSettled([cancel, create].filter(Boolean));
    }

    const second = await equipmentOrder("RACE-RESULT-FIRST");
    const created = await post(
      equipmentBody(
        second.orderId,
        second.itemId,
        `${PREFIX}-RACE-RESULT-FIRST`,
      ),
      randomUUID(),
    ).expect(201);
    expect(created.body.maintenanceOrderId).toBe(Number(second.orderId));
    await request(app.getHttpServer())
      .post(`/api/maintenance/orders/${second.orderId}:cancel`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .set("If-Match", "1")
      .send({})
      .expect(400);
  });

  it("E-O28 실제 예비품 매핑 writer 뒤 최종 매핑으로 등록을 판정한다", async () => {
    const { orderId, itemId } = await equipmentOrder("MAPPING-RACE");
    const spare = await prisma.spare_part.findUniqueOrThrow({
      where: { spare_part_id: sparePartId },
    });
    const barrier = await holdRow((tx) =>
      tx.$queryRaw(Prisma.sql`
        SELECT spare_part_id FROM mdm.spare_part
        WHERE spare_part_id=${sparePartId} FOR UPDATE`),
    );
    let writer: Promise<request.Response> | undefined;
    let create: Promise<request.Response> | undefined;
    try {
      writer = request(app.getHttpServer())
        .put(`/api/mdm/spare-parts/${sparePartId}/equipments`)
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .set("If-Match", String(spare.version_no))
        .send({ equipmentIds: [Number(otherEquipmentId)] })
        .then((response) => response);
      await waitForBlocked(
        (query) => query.includes("UPDATE") && query.includes("spare_part"),
      );
      create = post(
        equipmentBody(orderId, itemId, `${PREFIX}-MAPPING-RACE`),
        randomUUID(),
      ).then((response) => response);
      await waitForBlocked(
        (query) =>
          query.includes("FROM mdm.spare_part") && query.includes("FOR SHARE"),
      );
      barrier.release();
      const [updated, rejected] = await Promise.all([writer, create]);
      expect(updated.status).toBe(200);
      expect(rejected.status).toBe(400);
      expect(rejected.body.errors[0]).toMatchObject({
        field: "parts",
        code: "INVALID",
      });
      expect(
        await prisma.maintenance_result.count({
          where: { result_note: `${PREFIX}-MAPPING-RACE` },
        }),
      ).toBe(0);
    } finally {
      barrier.release();
      await barrier.done;
      await Promise.allSettled([writer, create].filter(Boolean));
    }
  });

  it("E-R26 멱등 헤더와 W-05-03/06 권한을 강제한다", async () => {
    const { orderId, itemId } = await equipmentOrder("GUARDS");
    const body = equipmentBody(orderId, itemId, `${PREFIX}-GUARDS`);
    await request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .send(body)
      .expect(400);
    await post(body, randomUUID(), noPermissionCookie).expect(403);
  });

  function equipmentBody(orderId: bigint, itemId: bigint, note: string) {
    return {
      targetTypeCode: "EQUIPMENT",
      targetId: Number(equipmentId),
      maintenanceOrderId: Number(orderId),
      startedAt: "2026-09-01T07:00:00.123456+07:00",
      finishedAt: "2026-09-01T08:00:00.654321+07:00",
      resultNote: note,
      performedByUserId: Number(performerId),
      lines: [
        {
          orderItemId: Number(itemId),
          resultCode: RESULT_CODE,
          remarks: "원문 비고",
        },
      ],
      parts: [
        {
          sparePartId: Number(sparePartId),
          partName: "입력 이름",
          usedQty: 2.5,
          goodsIssueId: Number(goodsIssueId),
          goodsIssueNo: "위조",
          issuedAt: "2000-01-01T00:00:00Z",
          uomCode: "FORGED",
        },
      ],
    };
  }

  function post(body: object, key: string, selectedCookie = cookie) {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", selectedCookie)
      .set("Idempotency-Key", key)
      .send(body);
  }

  async function equipmentOrder(suffix: string) {
    const order = await prisma.maintenance_order.create({
      data: {
        maintenance_order_no: `${PREFIX}-${suffix}`,
        target_type_code: "EQUIPMENT",
        equipment_id: equipmentId,
        order_type_code: "CORRECTIVE",
        status_code: "ISSUED",
        planned_date: new Date("2026-09-01"),
        assignee_user_id: performerId,
        issued_by: actorId,
        issued_at: new Date("2026-09-01T00:00:00Z"),
      },
    });
    const item = await prisma.maintenance_order_item.create({
      data: {
        maintenance_order_id: order.maintenance_order_id,
        sequence_no: 1,
        inspection_item_id: inspectionItemId,
        status_code: "PLANNED",
      },
    });
    return {
      orderId: order.maintenance_order_id,
      itemId: item.maintenance_order_item_id,
    };
  }

  async function moldOrder(suffix: string): Promise<bigint> {
    return (
      await prisma.maintenance_order.create({
        data: {
          maintenance_order_no: `${PREFIX}-${suffix}`,
          target_type_code: "MOLD",
          mold_id: moldId,
          order_type_code: "PREVENTIVE",
          status_code: "ISSUED",
        },
      })
    ).maintenance_order_id;
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
    equipmentId = await equipment("EQ");
    otherEquipmentId = await equipment("OTHER-EQ");
    inspectionItemId = (
      await prisma.equipment_inspection_item.create({
        data: {
          plant_id: plantId,
          inspection_item_code: `${PREFIX}-ITEM`,
          inspection_item_name: `${PREFIX}-ITEM`,
          data_type_code: "BOOLEAN",
          inspection_type_code: "MAINTENANCE",
          judgment_method_code: "BOOLEAN",
          sequence_no: 1,
        },
      })
    ).equipment_inspection_item_id;
    moldId = (
      await prisma.mold.create({
        data: {
          plant_id: plantId,
          mold_code: `${PREFIX}-MOLD`,
          mold_name: `${PREFIX}-MOLD`,
          status_code: "IN_SERVICE",
          tool_type_code: "MOLD",
          current_shot_count: 777n,
          version_no: 7,
        },
      })
    ).mold_id;
    breakdownId = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-BD`,
          equipment_id: equipmentId,
          reported_at: new Date("2026-09-01T00:00:00Z"),
          description: PREFIX,
          status_code: "RECEIVED",
        },
      })
    ).breakdown_id;
    const codeGroup = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: "MAINTENANCE_RESULT_LINE_RESULT" },
    });
    await prisma.code_value.create({
      data: {
        code_group_id: codeGroup.code_group_id,
        code: RESULT_CODE,
        code_name: RESULT_CODE,
      },
    });
    const uom = await prisma.uom.create({
      data: {
        uom_code: `${PREFIX}-EA`,
        uom_name: `${PREFIX}-EA`,
        decimal_scale: 6,
      },
    });
    sparePartId = (
      await prisma.spare_part.create({
        data: {
          spare_part_code: `${PREFIX}-SPARE`,
          spare_part_name: `${PREFIX}-SPARE`,
          plant_id: plantId,
          base_uom_id: uom.uom_id,
        },
      })
    ).spare_part_id;
    await prisma.spare_part_equipment.create({
      data: { spare_part_id: sparePartId, equipment_id: equipmentId },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        warehouse_code: PREFIX,
        warehouse_name: PREFIX,
        warehouse_type_code: "MATERIAL",
        management_level_code: "LOCATION",
        plant_id: plantId,
        business_unit_id: business.business_unit_id,
      },
    });
    const issues = await prisma.$queryRaw<{ goods_issue_id: bigint }[]>`
      INSERT INTO logistics.goods_issue
        (goods_issue_no,issue_type_code,source_document_type_code,
         source_document_id,source_warehouse_id,issued_at,status_code)
      VALUES (${`${PREFIX}-GI`},'MAINTENANCE','MANUAL',1,${warehouse.warehouse_id},
              TIMESTAMPTZ '2026-08-14 02:12:00.111222+00','POSTED')
      RETURNING goods_issue_id`;
    goodsIssueId = issues[0].goods_issue_id;
    await prisma.goods_issue_spare_line.create({
      data: {
        goods_issue_id: goodsIssueId,
        line_no: 1,
        spare_part_id: sparePartId,
        issue_qty: "100.000000",
        uom_id: uom.uom_id,
      },
    });

    const actor = await auth("ACTOR", ["W-05-02", "W-05-06", "W-06-08"]);
    actorId = actor.id;
    cookie = actor.cookie;
    secondCookie = (await auth("SECOND", ["W-05-06"])).cookie;
    noPermissionCookie = (await auth("NO-PERMISSION", [])).cookie;
    performerId = (await auth("PERFORMER", [])).id;
  }

  async function equipment(suffix: string): Promise<bigint> {
    return (
      await prisma.equipment.create({
        data: {
          plant_id: plantId,
          equipment_code: `${PREFIX}-${suffix}`,
          equipment_name: `${PREFIX}-${suffix}`,
          equipment_type_code: "MACHINE",
          status_code: "IN_SERVICE",
        },
      })
    ).equipment_id;
  }

  async function auth(suffix: string, permissions: string[]) {
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
    if (permissions.length)
      await prisma.role_permission.createMany({
        data: permissions.map((permission_code) => ({
          role_id: role.role_id,
          permission_code,
        })),
      });
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
      id: user.app_user_id,
      cookie: Array.isArray(raw) ? (raw as string[]) : [String(raw)],
    };
  }

  async function forbiddenSideEffects() {
    const [inventory, downtimes, workOrders, notifications] = await Promise.all(
      [
        prisma.inventory_transaction.count(),
        prisma.equipment_downtime.count(),
        prisma.work_order.count(),
        prisma.notification.count(),
      ],
    );
    return { inventory, downtimes, workOrders, notifications };
  }

  async function holdRow(
    lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<{ release: () => void; done: Promise<unknown> }> {
    let ready!: () => void;
    let release!: () => void;
    let released = false;
    const readyPromise = new Promise<void>((resolve) => (ready = resolve));
    const hold = new Promise<void>((resolve) => (release = resolve));
    const done = prisma.$transaction(async (tx) => {
      await lock(tx);
      ready();
      await hold;
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
    minimum = 1,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const rows = await prisma.$queryRaw<{ query: string }[]>`
        SELECT query FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock'`;
      if (rows.filter((row) => matches(row.query)).length >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("제어한 DB 잠금 대기를 관찰하지 못했습니다.");
  }

  async function cleanup(): Promise<void> {
    const results = await prisma.maintenance_result.findMany({
      where: { result_note: { startsWith: PREFIX } },
      select: { maintenance_result_id: true },
    });
    const resultIds = results.map((row) => row.maintenance_result_id);
    await prisma.maintenance_result_line.deleteMany({
      where: { maintenance_result_id: { in: resultIds } },
    });
    await prisma.maintenance_result_part.deleteMany({
      where: { maintenance_result_id: { in: resultIds } },
    });
    await prisma.maintenance_result.deleteMany({
      where: { maintenance_result_id: { in: resultIds } },
    });
    const orders = await prisma.maintenance_order.findMany({
      where: { maintenance_order_no: { startsWith: PREFIX } },
      select: { maintenance_order_id: true },
    });
    const orderIds = orders.map((row) => row.maintenance_order_id);
    await prisma.maintenance_order_trigger.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order_item.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.breakdown.deleteMany({
      where: { breakdown_no: { startsWith: PREFIX } },
    });
    const issues = await prisma.goods_issue.findMany({
      where: { goods_issue_no: { startsWith: PREFIX } },
      select: { goods_issue_id: true },
    });
    const issueIds = issues.map((row) => row.goods_issue_id);
    await prisma.goods_issue_spare_line.deleteMany({
      where: { goods_issue_id: { in: issueIds } },
    });
    await prisma.goods_issue.deleteMany({
      where: { goods_issue_id: { in: issueIds } },
    });
    await prisma.spare_part_equipment.deleteMany({
      where: { spare_part: { spare_part_code: { startsWith: PREFIX } } },
    });
    await prisma.spare_part.deleteMany({
      where: { spare_part_code: { startsWith: PREFIX } },
    });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: PREFIX } });
    await prisma.uom.deleteMany({
      where: { uom_code: { startsWith: PREFIX } },
    });
    const codeGroup = await prisma.code_group.findUnique({
      where: { group_code: "MAINTENANCE_RESULT_LINE_RESULT" },
    });
    if (codeGroup)
      await prisma.code_value.deleteMany({
        where: {
          code_group_id: codeGroup.code_group_id,
          code: { startsWith: PREFIX },
        },
      });
    await prisma.mold.deleteMany({
      where: { mold_code: { startsWith: PREFIX } },
    });
    await prisma.equipment_inspection_item.deleteMany({
      where: { inspection_item_code: { startsWith: PREFIX } },
    });
    await prisma.equipment.deleteMany({
      where: { equipment_code: { startsWith: PREFIX } },
    });
    const users = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const userIds = users.map((row) => row.app_user_id);
    const roles = await prisma.role.findMany({
      where: { role_code: { startsWith: PREFIX } },
      select: { role_id: true },
    });
    const roleIds = roles.map((row) => row.role_id);
    await prisma.idempotency_record.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.user_role.deleteMany({
      where: {
        OR: [{ app_user_id: { in: userIds } }, { role_id: { in: roleIds } }],
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
    await prisma.plant.deleteMany({
      where: { plant_code: { startsWith: PREFIX } },
    });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
  }
});
