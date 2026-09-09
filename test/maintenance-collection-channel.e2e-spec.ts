import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { hashPassword } from "../src/auth/password";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E_I33_CHANNEL";
const LOGIN_ID = `${PREFIX}-USER`;
const PASSWORD = "I-33-수집채널-조회-검증-비밀번호";

describe("수집 채널 (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let mappedId: number;
  let unmappedId: number;
  let equipmentId: number;
  let itemId: number;
  let processId: number;
  let oldSpecId: number;
  let oldVersionId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "api");
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();

    const [plant, uom] = await Promise.all([
      prisma.plant.findFirstOrThrow(),
      prisma.uom.findFirstOrThrow(),
    ]);
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: "I-33 수집 채널 조회", status_code: "EMPLOYED" },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const equipment = await prisma.equipment.create({
      data: {
        plant_id: plant.plant_id,
        equipment_code: `${PREFIX}-EQ`,
        equipment_name: "수집 채널 설비",
        equipment_type_code: "PRESS",
        status_code: "RUNNING",
      },
    });
    const otherEquipment = await prisma.equipment.create({
      data: {
        plant_id: plant.plant_id,
        equipment_code: `${PREFIX}-EQ-OTHER`,
        equipment_name: "동명 신호 설비",
        equipment_type_code: "PRESS",
        status_code: "RUNNING",
      },
    });
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`,
        item_name: "수집 채널 품목",
        item_type_code: "FINISHED_GOODS",
        base_uom_id: uom.uom_id,
      },
    });
    const process = await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PROCESS`,
        process_name: "수집 채널 공정",
        process_type_code: "MOLDING",
      },
    });
    const plan = await prisma.inspection_plan.create({
      data: {
        inspection_plan_code: `${PREFIX}-PLAN`,
        inspection_plan_name: "수집 채널 검사기준",
        inspection_type_code: "PQC",
        item_id: item.item_id,
        process_id: process.process_id,
      },
    });
    const oldVersion = await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: plan.inspection_plan_id,
        plan_version: 1,
        effective_from: new Date("2026-01-01T00:00:00.000Z"),
        sampling_method_code: "FULL",
        inspection_frequency_code: "EVERY_LOT",
        status_code: "CONFIRMED",
      },
    });
    const latestVersion = await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: plan.inspection_plan_id,
        plan_version: 2,
        effective_from: new Date("2026-02-01T00:00:00.000Z"),
        sampling_method_code: "FULL",
        inspection_frequency_code: "EVERY_LOT",
        status_code: "DRAFT",
      },
    });
    const oldSpec = await prisma.inspection_item_spec.create({
      data: {
        inspection_plan_version_id: oldVersion.inspection_plan_version_id,
        sequence_no: 1,
        inspection_item_code: "TEMP",
        inspection_item_name: "히터 온도 v1",
        data_type_code: "NUMERIC",
        uom_id: uom.uom_id,
      },
    });
    await prisma.inspection_item_spec.create({
      data: {
        inspection_plan_version_id: latestVersion.inspection_plan_version_id,
        sequence_no: 1,
        inspection_item_code: "TEMP",
        inspection_item_name: "히터 온도 v2",
        data_type_code: "NUMERIC",
        uom_id: uom.uom_id,
      },
    });
    const mapped = await prisma.collection_channel.create({
      data: {
        equipment_id: equipment.equipment_id,
        channel_key: `${PREFIX}.TEMP.01`,
        signal_name: "히터 온도",
        uom_id: uom.uom_id,
        inspection_item_id: oldSpec.inspection_item_spec_id,
        item_id: item.item_id,
        process_id: process.process_id,
      },
    });
    const unmapped = await prisma.collection_channel.create({
      data: {
        equipment_id: equipment.equipment_id,
        channel_key: `${PREFIX}.RAW.01`,
        is_active: false,
      },
    });
    await prisma.$executeRaw`
      INSERT INTO maintenance.collection_channel_observation
        (equipment_id, channel_key, last_value, observed_at)
      VALUES
        (${equipment.equipment_id}, ${`${PREFIX}.TEMP.01`}, ${"182.4"},
         ${"2026-09-09T03:42:03.123456Z"}::timestamptz),
        (${equipment.equipment_id}, ${`${PREFIX}.RAW.01`}, NULL,
         ${"2026-09-09T03:42:04.000001Z"}::timestamptz),
        (${equipment.equipment_id}, ${`${PREFIX}.NEW.01`}, ${""},
         ${"2026-09-09T03:42:05.000002Z"}::timestamptz),
        (${otherEquipment.equipment_id}, ${`${PREFIX}.TEMP.01`}, ${"other"},
         ${"2026-09-09T03:42:06.000003Z"}::timestamptz)`;
    mappedId = Number(mapped.collection_channel_id);
    unmappedId = Number(unmapped.collection_channel_id);
    equipmentId = Number(equipment.equipment_id);
    itemId = Number(item.item_id);
    processId = Number(process.process_id);
    oldSpecId = Number(oldSpec.inspection_item_spec_id);
    oldVersionId = Number(oldVersion.inspection_plan_version_id);
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("상세는 연결 표시 18칸과 상태 무관 최신 Rev 판정 및 ETag를 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/collection-channels/${mappedId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.headers.etag).toBe("1");
    expect(response.body).toEqual({
      collectionChannelId: mappedId,
      equipmentId,
      equipmentCode: `${PREFIX}-EQ`,
      channelKey: `${PREFIX}.TEMP.01`,
      signalName: "히터 온도",
      unitCode: expect.any(String),
      inspectionItemId: oldSpecId,
      itemId,
      itemCode: `${PREFIX}-ITEM`,
      processId,
      processCode: `${PREFIX}-PROCESS`,
      inspectionItemName: "히터 온도 v1",
      inspectionItemCode: "TEMP",
      inspectionItemUnitCode: expect.any(String),
      inspectionPlanVersionId: oldVersionId,
      inspectionPlanVersion: 1,
      inspectionItemIsCurrentRevision: false,
      isActive: true,
    });
  });

  it("미매핑 상세는 nullable을 null로 내고 없는 신호명·단위 키만 생략한다", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/maintenance/collection-channels/${unmappedId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body).toEqual({
      collectionChannelId: unmappedId,
      equipmentId,
      equipmentCode: `${PREFIX}-EQ`,
      channelKey: `${PREFIX}.RAW.01`,
      inspectionItemId: null,
      itemId: null,
      itemCode: null,
      processId: null,
      processCode: null,
      inspectionItemName: null,
      inspectionItemCode: null,
      inspectionItemUnitCode: null,
      inspectionPlanVersionId: null,
      inspectionPlanVersion: null,
      inspectionItemIsCurrentRevision: null,
      isActive: false,
    });
  });

  it("없는 상세는 404다", async () => {
    await request(app.getHttpServer())
      .get("/api/maintenance/collection-channels/999999999")
      .set("Cookie", cookie)
      .expect(404);
  });

  it("목록은 숨은 활성 기본값 없이 정렬·count·page를 함께 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/maintenance/collection-channels")
      .query({ equipmentId, page: 1, size: 1 })
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body).toEqual({
      items: [expect.objectContaining({ collectionChannelId: unmappedId, isActive: false })],
      totalCount: 2,
      page: { page: 1, size: 1, total: 2 },
    });
  });

  it("목록의 isActive 조건은 명시했을 때만 적용한다", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/maintenance/collection-channels")
      .query({ equipmentId, isActive: true })
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body.items).toEqual([
      expect.objectContaining({ collectionChannelId: mappedId, isActive: true }),
    ]);
    expect(response.body.totalCount).toBe(1);
    expect(response.body.page.total).toBe(1);
  });

  it("미매핑 관측은 활성 검사연결 부재로 고르고 등록 여부는 별도로 표시한다", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/maintenance/collection-channels/observations")
      .query({ equipmentId, unmappedOnly: true })
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body).toEqual({
      items: [
        {
          channelKey: `${PREFIX}.NEW.01`,
          lastValue: "",
          observedAt: "2026-09-09T03:42:05.000002Z",
          alreadyMapped: false,
        },
        {
          channelKey: `${PREFIX}.RAW.01`,
          observedAt: "2026-09-09T03:42:04.000001Z",
          alreadyMapped: true,
        },
      ],
      totalCount: 2,
    });
    expect(response.body).not.toHaveProperty("page");
  });

  it("설비가 다른 동명 관측은 독립이며 저장된 값·마이크로초를 그대로 낸다", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/maintenance/collection-channels/observations")
      .set("Cookie", cookie)
      .expect(200);

    expect(response.body.totalCount).toBe(4);
    expect(
      response.body.items.filter(
        (item: { channelKey: string }) => item.channelKey === `${PREFIX}.TEMP.01`,
      ),
    ).toEqual([
      {
        channelKey: `${PREFIX}.TEMP.01`,
        lastValue: "other",
        observedAt: "2026-09-09T03:42:06.000003Z",
        alreadyMapped: false,
      },
      {
        channelKey: `${PREFIX}.TEMP.01`,
        lastValue: "182.4",
        observedAt: "2026-09-09T03:42:03.123456Z",
        alreadyMapped: true,
      },
    ]);
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
    await prisma.collection_channel_observation.deleteMany({
      where: { equipment: { equipment_code: { startsWith: PREFIX } } },
    });
    await prisma.collection_channel.deleteMany({
      where: { equipment: { equipment_code: { startsWith: PREFIX } } },
    });
    await prisma.inspection_item_spec.deleteMany({
      where: { inspection_plan_version: { inspection_plan: { inspection_plan_code: `${PREFIX}-PLAN` } } },
    });
    await prisma.inspection_plan_version.deleteMany({
      where: { inspection_plan: { inspection_plan_code: `${PREFIX}-PLAN` } },
    });
    await prisma.inspection_plan.deleteMany({ where: { inspection_plan_code: `${PREFIX}-PLAN` } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
