import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { InspectionList } from "../src/maintenance/inspection/inspection-query.service";
import { InspectionView } from "../src/maintenance/inspection/inspection-view";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I30-GET";
const LOGIN_ID = `${PREFIX}-LOGIN`;
const PASSWORD = "I30-조회-검증-비밀번호";
const PATH = "/api/maintenance/inspections";
const PERIOD = { inspectedFrom: "2026-09-01", inspectedTo: "2026-09-01" };
const CALENDAR_TYPE = `${PREFIX}-CAL`;
const TRIGGER_TYPE = `${PREFIX}-TRIGGER`;

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
  ajv.addSchema(contract, "https://omf-mes.invalid/i30-contract");
  const pointer = path.replace(/~/g, "~0").replace(/\//g, "~1");
  return ajv.compile({
    $ref: `https://omf-mes.invalid/i30-contract#/paths/${pointer}/get/responses/200/content/application~1json/schema`,
  });
}

describe("설비 점검 조회 I-30 ① (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  const ids = {
    plant: 0n,
    seoulPlant: 0n,
    badPlant: 0n,
    equipment: 0n,
    otherEquipment: 0n,
    seoulEquipment: 0n,
    badEquipment: 0n,
    worker: 0n,
    item1: 0n,
    item2: 0n,
    item3: 0n,
  };
  const records: Record<string, bigint> = {};
  const listValidator = validator("/maintenance/inspections");
  const detailValidator = validator("/maintenance/inspections/{inspectionId}");

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
    const user = await prisma.app_user.create({
      data: {
        login_id: LOGIN_ID,
        user_name: "점검 조회",
        status_code: "EMPLOYED",
      },
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
  });

  afterAll(async () => {
    try {
      if (prisma) await cleanup();
    } finally {
      if (app) await app.close();
    }
  });

  it("E-I01 equipmentId·inspectionTypeCode·overallResultCode 전 필터와 totalCount=page.total", async () => {
    const body = await list({
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: "DAILY",
      overallResultCode: "FAIL",
      size: 1,
      page: 2,
    });
    expect(body.page).toEqual({ page: 2, size: 1, total: 2 });
    expect(body.totalCount).toBe(2);
    expect(body.items.map((item) => item.inspectionId)).toEqual([
      Number(records.latestFail),
    ]);
    const pass = await list({
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: "DAILY",
      overallResultCode: "PASS",
    });
    expect(pass.items.map((item) => item.inspectionId)).toEqual([
      Number(records.oldPass),
    ]);
    const custom = await list({
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: `${PREFIX}-CUSTOM`,
    });
    expect(custom.items[0].inspectionTypeCode).toBe(`${PREFIX}-CUSTOM`);
    expect(
      (await list({ ...PERIOD, inspectionTypeCode: "NOT-REGISTERED' --" }))
        .totalCount,
    ).toBe(0);
    expect(
      (
        await list({
          ...PERIOD,
          equipmentId: Number(ids.otherEquipment),
          inspectionTypeCode: "DAILY",
        })
      ).totalCount,
    ).toBe(1);
  });

  it("E-I02 기본 정렬은 inspectedAt 내림차순이고 늦게 수신된 옛 점검이 size=1을 빼앗지 않는다", async () => {
    const body = await list({
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: "DAILY",
      size: 1,
    });
    expect(body.items[0]).toMatchObject({
      inspectionId: Number(records.tieFail),
      overallResultCode: "FAIL",
    });
    expect(body.totalCount).toBe(3);
    const old = await prisma.equipment_inspection.findUniqueOrThrow({
      where: { equipment_inspection_id: records.oldPass },
    });
    const latest = await prisma.equipment_inspection.findUniqueOrThrow({
      where: { equipment_inspection_id: records.tieFail },
    });
    expect(old.created_at.getTime()).toBeGreaterThan(
      latest.created_at.getTime(),
    );
  });

  it("E-I03 동시각은 inspectionId로 고정하고 inspectedAtAsc는 오래된 순이다", async () => {
    const query = {
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: "DAILY",
    };
    const desc = await list(query);
    const asc = await list({ ...query, sort: "inspectedAtAsc" });
    expect(desc.items.map((item) => item.inspectionId)).toEqual(
      [records.tieFail, records.latestFail, records.oldPass].map(Number),
    );
    expect(asc.items.map((item) => item.inspectionId)).toEqual(
      [records.oldPass, records.latestFail, records.tieFail].map(Number),
    );
    expect((await list({ ...query, size: 1, page: 4 })).items).toEqual([]);
    expect((await list({ ...query, size: 999, page: 0 })).page).toEqual({
      page: 1,
      size: 200,
      total: 3,
    });
  });

  it.each([
    [{}, ["inspectedFrom", "inspectedTo"]],
    [{ inspectedFrom: "2026-09-01" }, ["inspectedTo"]],
    [{ inspectedTo: "2026-09-01" }, ["inspectedFrom"]],
    [{ withoutMaintenanceOrder: false }, ["inspectedFrom", "inspectedTo"]],
  ])(
    "E-I04 전 이력은 기간 두 칸을 요구하고 미발행만 생략한다: %j",
    async (query, missing) => {
      // 설계 미정 — 문의 094.
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query({
          equipmentId: Number(ids.equipment),
          inspectionTypeCode: "DAILY",
          size: 1,
          ...query,
        })
        .expect(400);
      expect(response.body.errors).toEqual(
        missing.map((name) =>
          expect.objectContaining({ field: name, code: "REQUIRED" }),
        ),
      );
    },
  );

  it("E-I05 설비 공장 로컬 From/To·월경계·다른공장·역전을 구분한다 — 094", async () => {
    const body = await list({
      ...PERIOD,
      inspectionTypeCode: CALENDAR_TYPE,
      size: 1,
    });
    expect(body.totalCount).toBe(4);
    expect(body.page.total).toBe(4);
    expect(body.items[0].inspectionId).toBe(Number(records.endInside));
    const all = await list({ ...PERIOD, inspectionTypeCode: CALENDAR_TYPE });
    expect(all.items.map((item) => item.inspectionId)).toEqual(
      [
        records.endInside,
        records.hanoi0030,
        records.startInclusive,
        records.seoulSameMoment,
      ].map(Number),
    );
    const hanoiLatest = await list({
      inspectedFrom: "2026-09-01",
      inspectedTo: "2026-09-01",
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: `${PREFIX}-MIDNIGHT`,
      size: 1,
    });
    expect(hanoiLatest.items[0].inspectedAt).toBe("2026-08-31T17:30:00.000Z");
    const august = await list({
      inspectedFrom: "2026-08-31",
      inspectedTo: "2026-08-31",
      inspectionTypeCode: CALENDAR_TYPE,
    });
    expect(august.items.map((item) => item.inspectionId)).toEqual(
      [records.beforeStart, records.hanoiSameMoment].map(Number),
    );
    const reverse = await list({
      inspectedFrom: "2026-09-02",
      inspectedTo: "2026-09-01",
      equipmentId: Number(ids.badEquipment),
    });
    expect(reverse).toEqual({
      items: [],
      totalCount: 0,
      page: { page: 1, size: 50, total: 0 },
    });
    const fromOnly = await list({
      inspectedFrom: "2026-09-01",
      withoutMaintenanceOrder: true,
      inspectionTypeCode: CALENDAR_TYPE,
    });
    expect(fromOnly.totalCount).toBe(5);
    const toOnly = await list({
      inspectedTo: "2026-08-31",
      withoutMaintenanceOrder: true,
      inspectionTypeCode: CALENDAR_TYPE,
    });
    expect(toOnly.items.map((item) => item.inspectionId)).toEqual(
      [records.beforeStart, records.hanoiSameMoment].map(Number),
    );
  });

  it.each([
    { inspectedFrom: "2026-02-30" },
    { inspectedTo: "2026-9-01" },
    { inspectedFrom: "2026-09-01T00:00:00Z" },
    { sort: "elapsedDesc" },
    { withoutMaintenanceOrder: "unknown" },
    { overallResultCode: "OK" },
    { equipmentId: "text" },
    { page: "text" },
    { size: "text" },
  ])(
    "E-I05 날짜·정렬·필터 형식 오류를 계약 가드가 거부한다: %j",
    async (invalid) => {
      await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query({ ...PERIOD, ...invalid })
        .expect(400);
    },
  );

  it.each(["Bad/Timezone", ""])(
    "E-I05 관련 공장의 잘못되거나 없는 시간대는 INTERNAL_ERROR다: %j",
    async (timezone) => {
      await prisma.plant.update({
        where: { plant_id: ids.badPlant },
        data: { timezone_code: timezone },
      });
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query({ ...PERIOD, equipmentId: Number(ids.badEquipment) })
        .expect(500);
      expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
      const noDates = await list({
        equipmentId: Number(ids.badEquipment),
        withoutMaintenanceOrder: true,
      });
      expect(noDates.items.map((item) => item.inspectionId)).toEqual([
        Number(records.badZone),
      ]);
      expect(
        (
          await list({
            ...PERIOD,
            equipmentId: Number(ids.badEquipment),
            inspectionTypeCode: "DAILY",
          })
        ).totalCount,
      ).toBe(0);
      expect(
        (
          await list({
            ...PERIOD,
            inspectionTypeCode: "DAILY",
            overallResultCode: "FAIL",
          })
        ).totalCount,
      ).toBe(2);
      // 해당 잘못된 공장도 발행된 기록뿐이면 미발행 대상이 아니다.
      expect(
        (
          await list({
            ...PERIOD,
            withoutMaintenanceOrder: true,
            inspectionTypeCode: `${PREFIX}-ISSUED-BAD`,
          })
        ).totalCount,
      ).toBe(0);
    },
  );

  it("E-I06 미발행 여부는 INSPECTION_NG source이며 같은 id의 BREAKDOWN 트리거는 제외하지 않는다", async () => {
    const body = await list({
      withoutMaintenanceOrder: true,
      inspectionTypeCode: TRIGGER_TYPE,
    });
    expect(body.items.map((item) => item.inspectionId)).toEqual(
      [records.unissuedPass, records.polymorphicFail].map(Number),
    );
    expect(body.totalCount).toBe(2);
    const page = await list({
      withoutMaintenanceOrder: true,
      inspectionTypeCode: TRIGGER_TYPE,
      overallResultCode: "FAIL",
      size: 1,
    });
    expect(page.items[0].inspectionId).toBe(Number(records.polymorphicFail));
    expect(page.page.total).toBe(1);
  });

  it("E-I07 취소된 보전지시도 발행 흔적이고 without 플래그는 FAIL·asc를 자동 선택하지 않는다", async () => {
    const all = await list({
      ...PERIOD,
      inspectionTypeCode: TRIGGER_TYPE,
      withoutMaintenanceOrder: false,
    });
    expect(all.totalCount).toBe(4);
    const unissued = await list({
      inspectionTypeCode: TRIGGER_TYPE,
      withoutMaintenanceOrder: true,
      size: 1,
    });
    expect(unissued.items[0]).toMatchObject({
      inspectionId: Number(records.unissuedPass),
      overallResultCode: "PASS",
    });
    const asc = await list({
      inspectionTypeCode: TRIGGER_TYPE,
      withoutMaintenanceOrder: true,
      sort: "inspectedAtAsc",
      size: 1,
    });
    expect(asc.items[0].inspectionId).toBe(Number(records.polymorphicFail));
  });

  it("E-I08 상세는 헤더·라인 10+6칸을 내리고 새 버전 ETag·versionNo를 내리지 않는다 — 내용 해시는 별개다", async () => {
    await prisma.equipment.update({
      where: { equipment_id: ids.equipment },
      data: { equipment_code: `${PREFIX}-EQ-CURRENT` },
    });
    await prisma.equipment_inspection_item.update({
      where: { equipment_inspection_item_id: ids.item1 },
      data: {
        inspection_item_name: "현재 항목 1",
        judgment_method_code: "MEASUREMENT",
      },
    });
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${records.latestFail}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(detailValidator(response.body)).toBe(true);
    expect(Object.keys(response.body)).toHaveLength(10);
    expect(response.body).toMatchObject({
      inspectionId: Number(records.latestFail),
      inspectionNo: `${PREFIX}-latestFail`,
      equipmentId: Number(ids.equipment),
      equipmentCode: `${PREFIX}-EQ-CURRENT`,
      inspectionTypeCode: "DAILY",
      overallResultCode: "FAIL",
      inspectedAt: "2026-09-01T02:00:00.000Z",
      inspectorWorkerNo: `${PREFIX}-WORKER`,
      remarks: null,
    });
    expect(response.body.versionNo).toBeUndefined();
    expect(response.headers.etag).not.toMatch(/^(W\/)?"?\d+"?$/);
    const body = response.body as InspectionView;
    expect(body.lines).toEqual([
      {
        inspectionItemId: Number(ids.item1),
        itemName: "현재 항목 1",
        judgeMethodCode: "MEASUREMENT",
        resultCode: "PASS",
        measuredValue: 12.345678,
        remarks: null,
      },
      {
        inspectionItemId: Number(ids.item2),
        itemName: "항목 2",
        judgeMethodCode: "VISUAL",
        resultCode: "PASS",
        measuredValue: null,
        remarks: "원문",
      },
      {
        inspectionItemId: Number(ids.item3),
        itemName: "항목 3",
        judgeMethodCode: "VISUAL",
        resultCode: "PASS",
        measuredValue: null,
        remarks: null,
      },
    ]);
    body.lines.forEach((line) => expect(Object.keys(line)).toHaveLength(6));
    const listBody = await list({
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      inspectionTypeCode: "DAILY",
    });
    expect(
      listBody.items.find(
        (item) => item.inspectionId === Number(records.latestFail),
      ),
    ).toEqual(body);
    const worker = await prisma.worker.findUniqueOrThrow({
      where: { worker_id: ids.worker },
    });
    expect(worker.app_user_id).toBeNull();
  });

  it("E-I09 없는 상세는 404이며 미인증은 기존 401이다", async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/-1`)
      .set("Cookie", cookie)
      .expect(404);
    expect(response.body.errors[0].code).toBe("NOT_FOUND");
    await request(app.getHttpServer())
      .get(`${PATH}/${records.latestFail}`)
      .expect(401);
    await request(app.getHttpServer()).get(PATH).query(PERIOD).expect(401);
  });

  it.each([
    { inspected_at: null },
    { inspected_by: null },
    { judgment_code: null },
    { judgment_code: "OK" },
    { judgment_code: "NG" },
  ])(
    "E-I09 필수값 없는 과거 헤더나 enum을 정상·404로 바꾸지 않는다: %j",
    async (data) => {
      // 설계 미정 — 문의 091. 조회용 결손 fixture이며 생성 API 지원 주장이 아니다.
      const row = await inspection(
        `invalid-${randomUUID()}`,
        "2026-09-01T01:00:00Z",
        `${PREFIX}-INVALID`,
        "PASS",
        ids.equipment,
        data,
      );
      try {
        const detail = await request(app.getHttpServer())
          .get(`${PATH}/${row}`)
          .set("Cookie", cookie)
          .expect(500);
        expect(detail.body.errors[0].code).toBe("INTERNAL_ERROR");
        const response = await request(app.getHttpServer())
          .get(PATH)
          .set("Cookie", cookie)
          .query({
            withoutMaintenanceOrder: true,
            inspectionTypeCode: `${PREFIX}-INVALID`,
          })
          .expect(500);
        expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
      } finally {
        await prisma.equipment_inspection.delete({
          where: { equipment_inspection_id: row },
        });
      }
    },
  );

  it.each(["OK", "NG"])(
    "E-I09 과거 라인 %s를 PASS로 꾸미지 않는다",
    async (code) => {
      const row = await inspection(
        `invalid-line-${code}`,
        "2026-09-01T01:00:00Z",
        `${PREFIX}-INVALID`,
        "PASS",
      );
      try {
        await prisma.equipment_inspection_result.create({
          data: {
            equipment_inspection_id: row,
            equipment_inspection_item_id: ids.item1,
            judgment_code: code,
          },
        });
        const response = await request(app.getHttpServer())
          .get(`${PATH}/${row}`)
          .set("Cookie", cookie)
          .expect(500);
        expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
        await request(app.getHttpServer())
          .get(PATH)
          .set("Cookie", cookie)
          .query({ ...PERIOD, inspectionTypeCode: `${PREFIX}-INVALID` })
          .expect(500);
      } finally {
        await prisma.equipment_inspection_result.deleteMany({
          where: { equipment_inspection_id: row },
        });
        await prisma.equipment_inspection.delete({
          where: { equipment_inspection_id: row },
        });
      }
    },
  );

  it.each([
    { ...PERIOD },
    { ...PERIOD, withoutMaintenanceOrder: true },
    { inspectedFrom: PERIOD.inspectedFrom, withoutMaintenanceOrder: true },
    { inspectedTo: PERIOD.inspectedTo, withoutMaintenanceOrder: true },
  ])(
    "기간 소속 불명의 NULL 시각을 목록·total에서 숨기지 않는다: %j",
    async (period) => {
      // 설계 미정 — 문의 091: 기간 포함 여부를 판정할 수 없어 page/count 전에 명시 실패한다.
      const type = `${PREFIX}-MISSING-TIME`;
      const valid = await inspection(
        "period-valid",
        "2026-09-01T01:00:00Z",
        type,
        "FAIL",
      );
      const invalid = await inspection(
        "period-invalid",
        "2026-09-01T01:00:00Z",
        type,
        "PASS",
        ids.equipment,
        { inspected_at: null },
      );
      try {
        const query = { ...period, inspectionTypeCode: type, size: 1 };
        const response = await request(app.getHttpServer())
          .get(PATH)
          .set("Cookie", cookie)
          .query(query)
          .expect(500);
        expect(response.body.errors[0].code).toBe("INTERNAL_ERROR");
        const matchingResult = await list({
          ...query,
          overallResultCode: "FAIL",
        });
        expect(matchingResult.totalCount).toBe(1);
        expect(matchingResult.items[0].inspectionId).toBe(Number(valid));
        const otherEquipment = await list({
          ...query,
          equipmentId: Number(ids.otherEquipment),
        });
        expect(otherEquipment.totalCount).toBe(0);
        const otherType = await list({
          ...query,
          inspectionTypeCode: `${PREFIX}-CUSTOM`,
        });
        expect(otherType.totalCount).toBe(1);
        const reversed = await list({
          ...query,
          inspectedFrom: "2026-09-02",
          inspectedTo: "2026-09-01",
        });
        expect(reversed.totalCount).toBe(0);
      } finally {
        await prisma.equipment_inspection.deleteMany({
          where: { equipment_inspection_id: { in: [valid, invalid] } },
        });
      }
    },
  );

  it("NULLS LAST 때문에 결손 시각이 최신 size=1을 빼앗지 않고 전체 페이지에서는 명시 실패한다", async () => {
    const type = `${PREFIX}-NULLS`;
    const valid = await inspection(
      "nulls-valid",
      "2026-09-01T01:00:00Z",
      type,
      "FAIL",
    );
    const invalid = await inspection(
      "nulls-invalid",
      "2026-09-01T01:00:00Z",
      type,
      "PASS",
      ids.equipment,
      { inspected_at: null },
    );
    try {
      const body = await list({
        withoutMaintenanceOrder: true,
        inspectionTypeCode: type,
        size: 1,
      });
      expect(body.items[0].inspectionId).toBe(Number(valid));
      expect(body.totalCount).toBe(2);
      await request(app.getHttpServer())
        .get(PATH)
        .set("Cookie", cookie)
        .query({
          withoutMaintenanceOrder: true,
          inspectionTypeCode: type,
          size: 1,
          page: 2,
        })
        .expect(500);
    } finally {
      await prisma.equipment_inspection.deleteMany({
        where: { equipment_inspection_id: { in: [valid, invalid] } },
      });
    }
  });

  async function list(query: Record<string, unknown>): Promise<InspectionList> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query(query)
      .expect(200);
    expect(listValidator(response.body)).toBe(true);
    const body = response.body as InspectionList;
    expect(body.totalCount).toBe(body.page.total);
    return body;
  }

  async function inspection(
    suffix: string,
    at: string,
    type = "DAILY",
    result = "PASS",
    equipment = ids.equipment,
    overrides: Partial<Prisma.equipment_inspectionUncheckedCreateInput> = {},
  ): Promise<bigint> {
    const row = await prisma.equipment_inspection.create({
      data: {
        inspection_no: `${PREFIX}-${suffix}`,
        equipment_id: equipment,
        inspection_type_code: type,
        inspected_at: new Date(at),
        inspected_by: ids.worker,
        judgment_code: result,
        // 조회 fixture의 기존 물리 필수칸. API 기본값을 정하는 쓰기는 후속 PR이다.
        status_code: "LEGACY",
        ...overrides,
      },
    });
    records[suffix] = row.equipment_inspection_id;
    return row.equipment_inspection_id;
  }

  async function order(
    suffix: string,
    sourceId: bigint,
    trigger = "INSPECTION_NG",
    status = "ISSUED",
  ): Promise<void> {
    await prisma.maintenance_order.create({
      data: {
        maintenance_order_no: `${PREFIX}-${suffix}`,
        target_type_code: "EQUIPMENT",
        equipment_id: ids.equipment,
        order_type_code: "CORRECTIVE",
        priority_code: "NORMAL",
        status_code: status,
        maintenance_order_trigger: {
          create: { trigger_type_code: trigger, source_id: sourceId },
        },
      },
    });
  }

  async function fixtures(): Promise<void> {
    const legal = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: "점검 조회 법인",
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    const business = await prisma.business_unit.create({
      data: {
        business_unit_code: PREFIX,
        business_unit_name: "점검 조회 사업부",
        legal_entity_id: legal.legal_entity_id,
      },
    });
    const plant = async (suffix: string, timezone: string): Promise<bigint> =>
      (
        await prisma.plant.create({
          data: {
            legal_entity_id: legal.legal_entity_id,
            business_unit_id: business.business_unit_id,
            plant_code: `${PREFIX}-${suffix}`,
            plant_name: suffix,
            timezone_code: timezone,
          },
        })
      ).plant_id;
    ids.plant = await plant("HN", "Asia/Ho_Chi_Minh");
    ids.seoulPlant = await plant("KR", "Asia/Seoul");
    ids.badPlant = await plant("BAD", "Bad/Timezone");
    const equipment = async (
      suffix: string,
      plantId: bigint,
    ): Promise<bigint> =>
      (
        await prisma.equipment.create({
          data: {
            plant_id: plantId,
            equipment_code: `${PREFIX}-${suffix}`,
            equipment_name: suffix,
            equipment_type_code: "MACHINE",
            status_code: "ACTIVE",
          },
        })
      ).equipment_id;
    ids.equipment = await equipment("EQ1", ids.plant);
    ids.otherEquipment = await equipment("EQ2", ids.plant);
    ids.seoulEquipment = await equipment("EQ-KR", ids.seoulPlant);
    ids.badEquipment = await equipment("EQ-BAD", ids.badPlant);
    ids.worker = (
      await prisma.worker.create({
        data: {
          worker_no: `${PREFIX}-WORKER`,
          worker_name: "계정 없는 점검자",
          business_unit_id: business.business_unit_id,
          plant_id: ids.plant,
          status_code: "EMPLOYED",
        },
      })
    ).worker_id;
    for (const [key, index, sequence] of [
      ["item1", 1, 10],
      ["item2", 2, 10],
      ["item3", 3, 20],
    ] as const) {
      ids[key] = (
        await prisma.equipment_inspection_item.create({
          data: {
            plant_id: ids.plant,
            inspection_item_code: `${PREFIX}-ITEM${index}`,
            inspection_item_name: `항목 ${index}`,
            data_type_code: "NUMBER",
            inspection_type_code: "DAILY",
            judgment_method_code: "VISUAL",
            sequence_no: sequence,
          },
        })
      ).equipment_inspection_item_id;
    }
    await inspection(
      "latestFail",
      "2026-09-01T02:00:00Z",
      "DAILY",
      "FAIL",
      ids.equipment,
      {
        created_at: new Date("2026-09-01T02:00:00Z"),
      },
    );
    await inspection(
      "tieFail",
      "2026-09-01T02:00:00Z",
      "DAILY",
      "FAIL",
      ids.equipment,
      {
        created_at: new Date("2026-09-01T02:01:00Z"),
      },
    );
    await inspection(
      "oldPass",
      "2026-09-01T00:00:00Z",
      "DAILY",
      "PASS",
      ids.equipment,
      {
        created_at: new Date("2026-09-02T00:00:00Z"),
      },
    );
    await inspection("monthly", "2026-09-01T04:00:00Z", "MONTHLY");
    await inspection("custom", "2026-09-01T03:00:00Z", `${PREFIX}-CUSTOM`);
    await inspection(
      "otherEquipment",
      "2026-09-01T05:00:00Z",
      "DAILY",
      "PASS",
      ids.otherEquipment,
    );
    await prisma.equipment_inspection_result.createMany({
      data: [
        {
          equipment_inspection_id: records.latestFail,
          equipment_inspection_item_id: ids.item3,
          judgment_code: "PASS",
        },
        {
          equipment_inspection_id: records.latestFail,
          equipment_inspection_item_id: ids.item2,
          judgment_code: "PASS",
          remarks: "원문",
        },
        {
          equipment_inspection_id: records.latestFail,
          equipment_inspection_item_id: ids.item1,
          judgment_code: "PASS",
          numeric_value: new Prisma.Decimal("12.345678"),
        },
      ],
    });
    for (const [suffix, at, equipmentId] of [
      ["beforeStart", "2026-08-31T16:59:59.999Z", ids.equipment],
      ["startInclusive", "2026-08-31T17:00:00Z", ids.equipment],
      ["hanoi0030", "2026-08-31T17:30:00Z", ids.equipment],
      ["endInside", "2026-09-01T16:59:59.999Z", ids.equipment],
      ["endExcluded", "2026-09-01T17:00:00Z", ids.equipment],
      ["seoulSameMoment", "2026-08-31T16:00:00Z", ids.seoulEquipment],
      ["hanoiSameMoment", "2026-08-31T16:00:00Z", ids.equipment],
    ] as const)
      await inspection(suffix, at, CALENDAR_TYPE, "PASS", equipmentId);
    await inspection(
      "midnightOld",
      "2026-08-31T16:30:00Z",
      `${PREFIX}-MIDNIGHT`,
    );
    await inspection(
      "midnightNew",
      "2026-08-31T17:30:00Z",
      `${PREFIX}-MIDNIGHT`,
      "FAIL",
    );
    await inspection(
      "badZone",
      "2026-09-01T00:00:00Z",
      `${PREFIX}-BAD`,
      "PASS",
      ids.badEquipment,
    );
    await inspection(
      "issuedBadZone",
      "2026-09-01T00:00:00Z",
      `${PREFIX}-ISSUED-BAD`,
      "PASS",
      ids.badEquipment,
    );
    await order("bad-issued", records.issuedBadZone);
    await inspection(
      "issuedFail",
      "2026-09-01T05:00:00Z",
      TRIGGER_TYPE,
      "FAIL",
    );
    await inspection(
      "cancelledFail",
      "2026-09-01T04:00:00Z",
      TRIGGER_TYPE,
      "FAIL",
    );
    await inspection(
      "unissuedPass",
      "2026-09-01T03:00:00Z",
      TRIGGER_TYPE,
      "PASS",
    );
    await inspection(
      "polymorphicFail",
      "2026-09-01T02:00:00Z",
      TRIGGER_TYPE,
      "FAIL",
    );
    await order("issued", records.issuedFail);
    await order(
      "cancelled",
      records.cancelledFail,
      "INSPECTION_NG",
      "CANCELLED",
    );
    await order("polymorphic", records.polymorphicFail, "BREAKDOWN");
  }

  async function cleanup(): Promise<void> {
    const inspections = await prisma.equipment_inspection.findMany({
      where: { inspection_no: { startsWith: `${PREFIX}-` } },
      select: { equipment_inspection_id: true },
    });
    const inspectionIds = inspections.map((row) => row.equipment_inspection_id);
    await prisma.equipment_inspection_result.deleteMany({
      where: { equipment_inspection_id: { in: inspectionIds } },
    });
    await prisma.equipment_inspection.deleteMany({
      where: { equipment_inspection_id: { in: inspectionIds } },
    });
    const orders = await prisma.maintenance_order.findMany({
      where: { maintenance_order_no: { startsWith: `${PREFIX}-` } },
      select: { maintenance_order_id: true },
    });
    const orderIds = orders.map((row) => row.maintenance_order_id);
    await prisma.maintenance_order_trigger.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    const plants = await prisma.plant.findMany({
      where: { plant_code: { startsWith: `${PREFIX}-` } },
      select: { plant_id: true },
    });
    const plantIds = plants.map((row) => row.plant_id);
    await prisma.equipment_inspection_item.deleteMany({
      where: {
        plant_id: { in: plantIds },
        inspection_item_code: { startsWith: `${PREFIX}-` },
      },
    });
    await prisma.equipment.deleteMany({
      where: {
        plant_id: { in: plantIds },
        equipment_code: { startsWith: `${PREFIX}-` },
      },
    });
    await prisma.worker.deleteMany({
      where: { worker_no: `${PREFIX}-WORKER` },
    });
    await prisma.plant.deleteMany({ where: { plant_id: { in: plantIds } } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
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
    expect(
      await prisma.equipment_inspection.count({
        where: { inspection_no: { startsWith: `${PREFIX}-` } },
      }),
    ).toBe(0);
    expect(
      await prisma.plant.count({ where: { plant_id: { in: plantIds } } }),
    ).toBe(0);
  }
});
