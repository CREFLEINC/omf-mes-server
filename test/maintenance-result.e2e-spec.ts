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
import { parseMaintenanceInstant } from "../src/maintenance/maintenance-instant";
import { MaintenanceResultList } from "../src/maintenance/result/result-query.service";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I31-Q2";
const LOGIN_ID = `${PREFIX}-LOGIN`;
const PASSWORD = "I31-실적조회-검증-비밀번호";
const PATH = "/api/maintenance/results";
const OVERLAP_ID = 831320001n;
const INACTIVE_RESULT = `${PREFIX}-INACTIVE`;

function validator(path: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, "../contracts/equipment-05설비툴.json"),
      "utf8",
    ),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ["int64", "double"]) ajv.addFormat(format, true);
  ajv.addSchema(contract, "https://omf-mes.invalid/i31-result-contract");
  const pointer = path.replace(/~/g, "~0").replace(/\//g, "~1");
  return ajv.compile({
    $ref: `https://omf-mes.invalid/i31-result-contract#/paths/${pointer}/get/responses/200/content/application~1json/schema`,
  });
}

describe("보전 실적 I-31 Q2 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let businessId = 0n;
  let hanoiPlantId = 0n;
  let newYorkPlantId = 0n;
  let newYorkEquipmentId = 0n;
  let actorId = 0n;
  let orderId = 0n;
  let legacyOrderId = 0n;
  let orderItemId = 0n;
  let eaUomId = 0n;
  let boxUomId = 0n;
  let spareWithUomId = 0n;
  let spareWithoutUomId = 0n;
  let singleIssueId = 0n;
  let multiIssueId = 0n;
  const records: Record<string, bigint> = {};
  const listValidator = validator("/maintenance/results");
  const detailValidator = validator(
    "/maintenance/results/{maintenanceResultId}",
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

  it("E-Q02/E-Q03 상세 header·line·part 전 필드와 ETag를 반환한다", async () => {
    const response = await detail(records.full);
    expect(response.headers.etag).toBe("7");
    expect(detailValidator(response.body)).toBe(true);
    expect(response.body).toMatchObject({
      maintenanceResultId: Number(records.full),
      maintenanceOrderId: Number(orderId),
      breakdownId: null,
      targetTypeCode: "EQUIPMENT",
      targetId: Number(OVERLAP_ID),
      startedAt: "2026-09-01T01:02:03.123456Z",
      finishedAt: "2026-09-01T02:03:04.654321Z",
      resultNote: `${PREFIX}-FULL`,
      performedByUserId: Number(actorId),
      isOutsourced: false,
      outsourceVendorName: null,
      resetCounter: false,
      shotCountBeforeReset: null,
      shotCountAfterReset: 0,
      closed: false,
      lines: [
        {
          orderItemId: Number(orderItemId),
          partName: null,
          resultCode: INACTIVE_RESULT,
          remarks: "라인 원문",
        },
      ],
    });
    expect(response.body).not.toHaveProperty("versionNo");
    expect(response.body.parts).toEqual([
      {
        sparePartId: Number(spareWithUomId),
        partName: "씰 원문",
        usedQty: 2.5,
        goodsIssueId: Number(singleIssueId),
        goodsIssueNo: `${PREFIX}-GI-SINGLE`,
        issuedAt: "2026-08-14T02:12:00.111222Z",
        uomCode: `${PREFIX}-EA`,
      },
      {
        sparePartId: Number(spareWithUomId),
        usedQty: 1,
        goodsIssueId: Number(multiIssueId),
        goodsIssueNo: `${PREFIX}-GI-MULTI`,
        issuedAt: "2026-08-15T02:12:00.333444Z",
        uomCode: null,
      },
      {
        sparePartId: Number(spareWithUomId),
        usedQty: 3,
        goodsIssueId: null,
        goodsIssueNo: null,
        issuedAt: null,
        uomCode: `${PREFIX}-EA`,
      },
      {
        sparePartId: Number(spareWithoutUomId),
        usedQty: 4,
        goodsIssueId: null,
        goodsIssueNo: null,
        issuedAt: null,
        uomCode: null,
      },
    ]);
  });

  it("E-Q09 비활성 고객 결과코드도 저장된 문자열 그대로 읽는다", async () => {
    const group = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: "MAINTENANCE_RESULT_LINE_RESULT" },
    });
    const code = await prisma.code_value.findUniqueOrThrow({
      where: {
        code_group_id_code: {
          code_group_id: group.code_group_id,
          code: INACTIVE_RESULT,
        },
      },
    });
    expect(code.is_active).toBe(false);
    expect((await detail(records.full)).body.lines[0].resultCode).toBe(
      INACTIVE_RESULT,
    );
  });

  it("E-Q04 order·type 없는 겹치는 targetId 필터가 두 대상형을 모두 읽는다", async () => {
    const byOrder = await list({ maintenanceOrderId: Number(orderId) });
    expect(byOrder.items.map((row) => row.maintenanceResultId)).toEqual([
      Number(records.full),
    ]);
    const overlapping = await list({
      targetId: Number(OVERLAP_ID),
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    expect(new Set(overlapping.items.map((row) => row.targetTypeCode))).toEqual(
      new Set(["EQUIPMENT", "MOLD"]),
    );
    expect(
      (
        await list({
          targetTypeCode: "MOLD",
          targetId: Number(OVERLAP_ID),
          startedFrom: "2026-09-01",
          startedTo: "2026-09-01",
        })
      ).items.map((row) => row.maintenanceResultId),
    ).toEqual([Number(records.mold)]);
  });

  it("E-Q05 공장별 25시간 DST일과 Hanoi 달력일 양끝을 각각 적용한다", async () => {
    const body = await list({
      startedFrom: "2026-11-01",
      startedTo: "2026-11-01",
    });
    expect(new Set(body.items.map((row) => row.maintenanceResultId))).toEqual(
      new Set([records.nyStart, records.nyEnd, records.hanoiStart].map(Number)),
    );
    expect(
      body.items.find(
        (row) => row.maintenanceResultId === Number(records.nyEnd),
      )?.startedAt,
    ).toBe("2026-11-02T04:59:59.999999Z");
    await prisma.plant.update({
      where: { plant_id: newYorkPlantId },
      data: { timezone_code: "Bad/Timezone" },
    });
    try {
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query({
          targetTypeCode: "EQUIPMENT",
          targetId: Number(newYorkEquipmentId),
          startedFrom: "2026-11-01",
          startedTo: "2026-11-01",
        })
        .expect(500);
      expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
    } finally {
      await prisma.plant.update({
        where: { plant_id: newYorkPlantId },
        data: { timezone_code: "America/New_York" },
      });
    }
  });

  it("E-Q07 같은 startedAt은 result ID 내림차순으로 페이지가 고정된다", async () => {
    const query = {
      targetTypeCode: "EQUIPMENT",
      targetId: Number(newYorkEquipmentId),
      startedFrom: "2026-10-01",
      startedTo: "2026-10-01",
    };
    const all = await list(query);
    expect(all.items.map((row) => row.maintenanceResultId)).toEqual([
      Number(records.tieSecond),
      Number(records.tieFirst),
    ]);
    expect(
      (await list({ ...query, page: 1, size: 1 })).items[0].maintenanceResultId,
    ).toBe(Number(records.tieSecond));
    expect(
      (await list({ ...query, page: 2, size: 1 })).items[0].maintenanceResultId,
    ).toBe(Number(records.tieFirst));
  });

  it("E-Q06 없는 상세·필터·역전·size clamp와 형식 오류를 구분한다", async () => {
    await request(app.getHttpServer())
      .get(`${PATH}/831329999`)
      .set("Cookie", cookie)
      .expect(404);
    const empty = await list({ maintenanceOrderId: 831329999 });
    expect(empty).toEqual({
      items: [],
      totalCount: 0,
      page: { page: 1, size: 50, total: 0 },
    });
    const reverse = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query({ startedFrom: "2026-09-02", startedTo: "2026-09-01" })
      .expect(400);
    expect(reverse.body.errors[0]).toMatchObject({
      field: "startedTo",
      code: "RANGE",
    });
    expect(
      (
        await list({
          targetTypeCode: "EQUIPMENT",
          targetId: Number(newYorkEquipmentId),
          startedFrom: "2026-10-01",
          startedTo: "2026-10-01",
          page: 0,
          size: 999,
        })
      ).page,
    ).toEqual({ page: 1, size: 200, total: 2 });
    for (const query of [
      { targetTypeCode: "TOOL" },
      { startedFrom: "2026-02-30" },
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

  it("E-Q08 target/note 결손 구행은 상세·목록에서 숨기거나 추측하지 않는다", async () => {
    const legacy = await prisma.$queryRaw<{ maintenance_result_id: bigint }[]>`
      INSERT INTO maintenance.maintenance_result
        (maintenance_order_id,started_at,created_by)
      VALUES (${legacyOrderId},TIMESTAMPTZ '2026-12-01 00:00:00+00',${actorId})
      RETURNING maintenance_result_id`;
    records.legacy = legacy[0].maintenance_result_id;
    try {
      for (const path of [`${PATH}/${records.legacy}`, PATH]) {
        const call = request(app.getHttpServer())
          .get(path)
          .set("Cookie", cookie);
        if (path === PATH)
          call.query({ maintenanceOrderId: Number(legacyOrderId) });
        const response = await call.expect(500);
        expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
      }
    } finally {
      await prisma.maintenance_result.delete({
        where: { maintenance_result_id: records.legacy },
      });
    }
  });

  it("E-Q10 µs6·negative epoch·ISO year 0000·큰 offset을 상세에서 보존한다", async () => {
    expect((await detail(records.negative)).body.startedAt).toBe(
      "1969-12-31T23:59:59.999999Z",
    );
    expect((await detail(records.yearZero)).body.startedAt).toBe(
      "0000-01-01T00:00:00.000000Z",
    );
    expect((await detail(records.largeOffset)).body.startedAt).toBe(
      "2026-09-01T00:00:59.123456Z",
    );
  });

  async function detail(id: bigint): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`${PATH}/${id}`)
      .set("Cookie", cookie)
      .expect(200);
  }

  async function list(
    query: Record<string, unknown>,
  ): Promise<MaintenanceResultList> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query(query)
      .expect(200);
    expect(listValidator(response.body)).toBe(true);
    return response.body as MaintenanceResultList;
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
    businessId = business.business_unit_id;
    hanoiPlantId = await plant(
      "HANOI",
      "Asia/Ho_Chi_Minh",
      legal.legal_entity_id,
    );
    newYorkPlantId = await plant(
      "NY",
      "America/New_York",
      legal.legal_entity_id,
    );
    await prisma.$executeRaw`
      INSERT INTO mdm.equipment
        (equipment_id,equipment_code,equipment_name,equipment_type_code,status_code,plant_id)
      OVERRIDING SYSTEM VALUE
      VALUES (${OVERLAP_ID},${`${PREFIX}-EQ`},${PREFIX},'MACHINE','ACTIVE',${hanoiPlantId})`;
    await prisma.$executeRaw`
      INSERT INTO mdm.mold
        (mold_id,mold_code,mold_name,status_code,tool_type_code,plant_id)
      OVERRIDING SYSTEM VALUE
      VALUES (${OVERLAP_ID},${`${PREFIX}-MOLD`},${PREFIX},'IN_SERVICE','MOLD',${hanoiPlantId})`;
    newYorkEquipmentId = (
      await prisma.equipment.create({
        data: {
          equipment_code: `${PREFIX}-NY-EQ`,
          equipment_name: PREFIX,
          equipment_type_code: "MACHINE",
          status_code: "ACTIVE",
          plant_id: newYorkPlantId,
        },
      })
    ).equipment_id;
    actorId = await authFixture();
    await referenceFixtures();
    await resultFixtures();
  }

  async function plant(
    suffix: string,
    timezone: string,
    legalEntityId: bigint,
  ): Promise<bigint> {
    return (
      await prisma.plant.create({
        data: {
          plant_code: `${PREFIX}-${suffix}`,
          plant_name: `${PREFIX}-${suffix}`,
          legal_entity_id: legalEntityId,
          business_unit_id: businessId,
          timezone_code: timezone,
        },
      })
    ).plant_id;
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
    const response = await request(app.getHttpServer())
      .post("/api/app/sessions")
      .set("Idempotency-Key", randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers["set-cookie"];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
    return user.app_user_id;
  }

  async function referenceFixtures(): Promise<void> {
    const group = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: "MAINTENANCE_RESULT_LINE_RESULT" },
    });
    await prisma.code_value.create({
      data: {
        code_group_id: group.code_group_id,
        code: INACTIVE_RESULT,
        code_name: INACTIVE_RESULT,
        is_active: false,
      },
    });
    eaUomId = (
      await prisma.uom.create({
        data: { uom_code: `${PREFIX}-EA`, uom_name: "EA", decimal_scale: 0 },
      })
    ).uom_id;
    boxUomId = (
      await prisma.uom.create({
        data: { uom_code: `${PREFIX}-BOX`, uom_name: "BOX", decimal_scale: 0 },
      })
    ).uom_id;
    const warehouse = await prisma.warehouse.create({
      data: {
        warehouse_code: PREFIX,
        warehouse_name: PREFIX,
        warehouse_type_code: "MATERIAL",
        management_level_code: "LOCATION",
        plant_id: hanoiPlantId,
        business_unit_id: businessId,
      },
    });
    spareWithUomId = (
      await prisma.spare_part.create({
        data: {
          spare_part_code: `${PREFIX}-SPARE-EA`,
          spare_part_name: PREFIX,
          plant_id: hanoiPlantId,
          base_uom_id: eaUomId,
        },
      })
    ).spare_part_id;
    spareWithoutUomId = (
      await prisma.spare_part.create({
        data: {
          spare_part_code: `${PREFIX}-SPARE-NULL`,
          spare_part_name: PREFIX,
          plant_id: hanoiPlantId,
        },
      })
    ).spare_part_id;
    singleIssueId = await goodsIssue(
      "SINGLE",
      "2026-08-14 02:12:00.111222+00",
      warehouse.warehouse_id,
    );
    multiIssueId = await goodsIssue(
      "MULTI",
      "2026-08-15 02:12:00.333444+00",
      warehouse.warehouse_id,
    );
    await prisma.goods_issue_spare_line.createMany({
      data: [
        {
          goods_issue_id: singleIssueId,
          line_no: 1,
          spare_part_id: spareWithUomId,
          issue_qty: "2.500000",
          uom_id: eaUomId,
        },
        {
          goods_issue_id: multiIssueId,
          line_no: 1,
          spare_part_id: spareWithUomId,
          issue_qty: "1.000000",
          uom_id: eaUomId,
        },
        {
          goods_issue_id: multiIssueId,
          line_no: 2,
          spare_part_id: spareWithUomId,
          issue_qty: "1.000000",
          uom_id: boxUomId,
        },
      ],
    });
  }

  async function goodsIssue(
    suffix: string,
    issuedAt: string,
    warehouseId: bigint,
  ): Promise<bigint> {
    const rows = await prisma.$queryRaw<{ goods_issue_id: bigint }[]>`
      INSERT INTO logistics.goods_issue
        (goods_issue_no,issue_type_code,source_document_type_code,
         source_document_id,source_warehouse_id,issued_at,status_code)
      VALUES (${`${PREFIX}-GI-${suffix}`},'MAINTENANCE','MANUAL',1,
              ${warehouseId},CAST(${issuedAt} AS timestamptz),'ISSUED')
      RETURNING goods_issue_id`;
    return rows[0].goods_issue_id;
  }

  async function resultFixtures(): Promise<void> {
    orderId = await order("ORDER");
    legacyOrderId = await order("LEGACY-ORDER");
    orderItemId = (
      await prisma.maintenance_order_item.create({
        data: {
          maintenance_order_id: orderId,
          sequence_no: 1,
          item_name: "항목 원문",
          status_code: "PLANNED",
        },
      })
    ).maintenance_order_item_id;
    records.full = await rawResult({
      note: `${PREFIX}-FULL`,
      startedAt: "2026-09-01 01:02:03.123456+00",
      completedAt: "2026-09-01 02:03:04.654321+00",
      maintenanceOrderId: orderId,
      performerId: actorId,
      version: 7,
    });
    await prisma.maintenance_result_line.create({
      data: {
        maintenance_result_id: records.full,
        sequence_no: 1,
        maintenance_order_item_id: orderItemId,
        result_code: INACTIVE_RESULT,
        remarks: "라인 원문",
      },
    });
    await prisma.maintenance_result_part.createMany({
      data: [
        {
          maintenance_result_id: records.full,
          sequence_no: 1,
          spare_part_id: spareWithUomId,
          part_name: "씰 원문",
          used_qty: "2.500000",
          goods_issue_id: singleIssueId,
        },
        {
          maintenance_result_id: records.full,
          sequence_no: 2,
          spare_part_id: spareWithUomId,
          used_qty: "1.000000",
          goods_issue_id: multiIssueId,
        },
        {
          maintenance_result_id: records.full,
          sequence_no: 3,
          spare_part_id: spareWithUomId,
          used_qty: "3.000000",
        },
        {
          maintenance_result_id: records.full,
          sequence_no: 4,
          spare_part_id: spareWithoutUomId,
          used_qty: "4.000000",
        },
      ],
    });
    records.mold = await rawResult({
      note: `${PREFIX}-MOLD`,
      targetType: "MOLD",
      startedAt: "2026-09-01 03:00:00+00",
    });
    records.tieFirst = await rawResult({
      note: `${PREFIX}-TIE-1`,
      targetId: newYorkEquipmentId,
      startedAt: "2026-10-01 12:00:00+00",
    });
    records.tieSecond = await rawResult({
      note: `${PREFIX}-TIE-2`,
      targetId: newYorkEquipmentId,
      startedAt: "2026-10-01 12:00:00+00",
    });
    records.nyStart = await rawResult({
      note: `${PREFIX}-NY-START`,
      targetId: newYorkEquipmentId,
      startedAt: "2026-11-01 04:00:00+00",
    });
    records.nyEnd = await rawResult({
      note: `${PREFIX}-NY-END`,
      targetId: newYorkEquipmentId,
      startedAt: "2026-11-02 04:59:59.999999+00",
    });
    records.nyOutside = await rawResult({
      note: `${PREFIX}-NY-OUTSIDE`,
      targetId: newYorkEquipmentId,
      startedAt: "2026-11-02 05:00:00+00",
    });
    records.hanoiStart = await rawResult({
      note: `${PREFIX}-HANOI-START`,
      startedAt: "2026-10-31 17:00:00+00",
    });
    records.negative = await rawResult({
      note: `${PREFIX}-NEGATIVE`,
      startedAt: "1969-12-31 23:59:59.999999+00",
    });
    records.yearZero = await rawResult({
      note: `${PREFIX}-YEAR-ZERO`,
      startedAt: "0001-01-01 00:00:00+00 BC",
    });
    const offset = parseMaintenanceInstant(
      "2026-09-01T23:59:59.123456+23:59",
      "startedAt",
    );
    records.largeOffset = await rawResult({
      note: `${PREFIX}-OFFSET`,
      startedAt: offset.sqlTimestamp,
    });
  }

  async function order(suffix: string): Promise<bigint> {
    return (
      await prisma.maintenance_order.create({
        data: {
          maintenance_order_no: `${PREFIX}-${suffix}`,
          target_type_code: "EQUIPMENT",
          equipment_id: OVERLAP_ID,
          order_type_code: "CORRECTIVE",
          status_code: "ISSUED",
          planned_date: new Date("2026-09-01"),
        },
      })
    ).maintenance_order_id;
  }

  async function rawResult(input: {
    note: string;
    startedAt: string;
    completedAt?: string;
    targetType?: "EQUIPMENT" | "MOLD";
    targetId?: bigint;
    maintenanceOrderId?: bigint;
    performerId?: bigint;
    version?: number;
  }): Promise<bigint> {
    const type = input.targetType ?? "EQUIPMENT";
    const targetId = input.targetId ?? OVERLAP_ID;
    const rows = await prisma.$queryRaw<{ maintenance_result_id: bigint }[]>`
      INSERT INTO maintenance.maintenance_result
        (maintenance_order_id,target_type_code,equipment_id,mold_id,started_at,
         completed_at,result_note,performed_by_user_id,is_outsourced,
         outsource_vendor_name,reset_counter,shot_count_before_reset,
         shot_count_after_reset,closed,version_no,created_by)
      VALUES (${input.maintenanceOrderId ?? null},${type},
              ${type === "EQUIPMENT" ? targetId : null},
              ${type === "MOLD" ? targetId : null},
              CAST(${input.startedAt} AS timestamptz),
              CAST(${input.completedAt ?? null} AS timestamptz),${input.note},
              ${input.performerId ?? null},false,NULL,false,NULL,0,false,
              ${input.version ?? 1},${actorId})
      RETURNING maintenance_result_id`;
    return rows[0].maintenance_result_id;
  }

  async function cleanup(): Promise<void> {
    const results = await prisma.maintenance_result.findMany({
      where: {
        OR: [
          { result_note: { startsWith: PREFIX } },
          {
            maintenance_order: { maintenance_order_no: { startsWith: PREFIX } },
          },
        ],
      },
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
    await prisma.maintenance_order_item.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
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
    await prisma.spare_part.deleteMany({
      where: { spare_part_code: { startsWith: PREFIX } },
    });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: PREFIX } });
    await prisma.uom.deleteMany({
      where: { uom_code: { startsWith: PREFIX } },
    });
    const group = await prisma.code_group.findUnique({
      where: { group_code: "MAINTENANCE_RESULT_LINE_RESULT" },
    });
    if (group)
      await prisma.code_value.deleteMany({
        where: { code_group_id: group.code_group_id, code: INACTIVE_RESULT },
      });
    await prisma.mold.deleteMany({ where: { mold_code: `${PREFIX}-MOLD` } });
    await prisma.equipment.deleteMany({
      where: { equipment_code: { startsWith: PREFIX } },
    });
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
    await prisma.plant.deleteMany({
      where: { plant_code: { startsWith: PREFIX } },
    });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
    expect(
      await prisma.maintenance_result.count({
        where: { result_note: { startsWith: PREFIX } },
      }),
    ).toBe(0);
  }
});
