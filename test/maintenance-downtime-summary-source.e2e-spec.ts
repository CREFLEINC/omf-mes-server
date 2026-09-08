import { Prisma } from "@prisma/client";

import { DowntimeSummarySourceService } from "../src/maintenance/downtime/downtime-summary-source.service";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I32-SUMMARY-SOURCE";

describe("I-32 비가동 요약 원천 (e2e)", () => {
  const prisma = new PrismaService();
  const ids: Record<string, bigint> = {};
  let source: DowntimeSummarySourceService;

  beforeAll(async () => {
    await prisma.$connect();
    source = new DowntimeSummarySourceService(prisma);
    await cleanup();
    await fixtures();
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("설비그룹은 production_line 하위 계층과 장비 세션만 포함한다", async () => {
    const result = await source.read({
      equipmentGroupId: Number(ids.parentLine),
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });

    expect(result.plants.map((plant) => plant.plantId)).toEqual([
      ids.hcmPlant.toString(),
    ]);
    expect(result.equipment.map((item) => item.equipmentId)).toEqual([
      ids.childEquipment.toString(),
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].equipmentId).toBe(ids.childEquipment.toString());
    expect(result.downtimes).toHaveLength(3);
    expect(result.openIntervalCount).toBe(1);
  });

  it("공장 조회는 terminal 공장의 무장비 세션을 포함하고 열린 세션은 뺀다", async () => {
    const result = await source.read({
      plantId: Number(ids.hcmPlant),
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });

    expect(result.sessions).toHaveLength(2);
    expect(
      result.sessions.filter((row) => row.equipmentId === null),
    ).toHaveLength(1);
    expect(result.sessions.map((row) => row.sessionId)).not.toContain(
      ids.openSession.toString(),
    );
  });

  it("반열린 로컬 기간 경계와 원본 마이크로초·0초 행을 보존한다", async () => {
    const result = await source.read({
      equipmentId: Number(ids.childEquipment),
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    const plant = result.plants[0];
    const crossing = result.downtimes.find(
      (row) => row.downtimeId === ids.crossingDowntime.toString(),
    );
    const zero = result.downtimes.find(
      (row) => row.downtimeId === ids.zeroDowntime.toString(),
    );

    expect(plant.rangeStartUs).toBe(1788195600000000n);
    expect(plant.rangeEndUs).toBe(1788282000000000n);
    expect(crossing).toMatchObject({
      startedAtUs: 1788195599999999n,
      endedAtUs: 1788196200123456n,
      rangeStartUs: plant.rangeStartUs,
      rangeEndUs: plant.rangeEndUs,
      reasonName: "실행 중 정지",
    });
    expect(zero?.startedAtUs).toBe(zero?.endedAtUs);
  });

  it("폐지된 사유는 원본 code만 남기고 현재 이름을 붙이지 않는다", async () => {
    const result = await source.read({
      equipmentId: Number(ids.childEquipment),
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    expect(
      result.downtimes.find((row) => row.reasonCode === `${PREFIX}-INACTIVE`),
    ).toMatchObject({ reasonName: null });
  });

  it("설비·공장 필터가 모순이면 빈 원천을 낸다", async () => {
    await expect(
      source.read({
        plantId: Number(ids.seoulPlant),
        equipmentId: Number(ids.childEquipment),
        startedFrom: "2026-09-01",
        startedTo: "2026-09-01",
      }),
    ).resolves.toEqual({
      plants: [],
      equipment: [],
      sessions: [],
      downtimes: [],
      openIntervalCount: 0,
    });
  });

  it("종료일이 시작일보다 빠르면 RANGE 400 예외를 낸다", async () => {
    await expect(
      source.read({ startedFrom: "2026-09-02", startedTo: "2026-09-01" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  async function fixtures(): Promise<void> {
    const reasonGroup = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: "DOWNTIME_REASON" },
    });
    await prisma.code_value.createMany({
      data: [
        {
          code_group_id: reasonGroup.code_group_id,
          code: `${PREFIX}-ACTIVE`,
          code_name: "실행 중 정지",
          is_active: true,
        },
        {
          code_group_id: reasonGroup.code_group_id,
          code: `${PREFIX}-INACTIVE`,
          code_name: "폐기 사유",
          is_active: false,
        },
      ],
    });
    const legal = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: PREFIX,
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    ids.legal = legal.legal_entity_id;
    const business = await prisma.business_unit.create({
      data: {
        legal_entity_id: legal.legal_entity_id,
        business_unit_code: PREFIX,
        business_unit_name: PREFIX,
      },
    });
    ids.business = business.business_unit_id;
    for (const [name, timezone] of [
      ["hcm", "Asia/Ho_Chi_Minh"],
      ["seoul", "Asia/Seoul"],
    ] as const) {
      const plant = await prisma.plant.create({
        data: {
          legal_entity_id: legal.legal_entity_id,
          business_unit_id: business.business_unit_id,
          plant_code: `${PREFIX}-${name}`,
          plant_name: name,
          timezone_code: timezone,
        },
      });
      ids[`${name}Plant`] = plant.plant_id;
    }
    const parent = await prisma.production_line.create({
      data: {
        plant_id: ids.hcmPlant,
        line_code: `${PREFIX}-PARENT`,
        line_name: "상위 그룹",
      },
    });
    ids.parentLine = parent.production_line_id;
    const child = await prisma.production_line.create({
      data: {
        plant_id: ids.hcmPlant,
        parent_line_id: parent.production_line_id,
        line_code: `${PREFIX}-CHILD`,
        line_name: "하위 그룹",
      },
    });
    ids.childLine = child.production_line_id;
    ids.childEquipment = (
      await prisma.equipment.create({
        data: {
          plant_id: ids.hcmPlant,
          production_line_id: child.production_line_id,
          equipment_code: `${PREFIX}-EQUIPMENT`,
          equipment_name: "하위 설비",
          equipment_type_code: "MACHINE",
          status_code: "ACTIVE",
        },
      })
    ).equipment_id;
    const terminal = await prisma.terminal.create({
      data: {
        terminal_code: `${PREFIX}-TERMINAL`,
        plant_id: ids.hcmPlant,
        terminal_type_code: "POP",
        status_code: "ACTIVE",
      },
    });
    ids.terminal = terminal.terminal_id;
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`,
        item_name: PREFIX,
        item_type_code: "FINISHED_GOODS",
        base_uom_id: uom.uom_id,
        lot_controlled: false,
      },
    });
    ids.item = item.item_id;
    const process = await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PROCESS`,
        process_name: PREFIX,
        process_type_code: "ASSEMBLY",
      },
    });
    ids.process = process.process_id;
    const routing = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-ROUTING`,
        routing_version: 1,
        status_code: "ACTIVE",
      },
    });
    ids.routing = routing.routing_id;
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        process_id: process.process_id,
        operation_seq: 10,
        operation_name: PREFIX,
      },
    });
    ids.operation = operation.routing_operation_id;
    const order = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 1,
        uom_id: uom.uom_id,
        status_code: "IN_PROGRESS",
      },
    });
    ids.order = order.work_order_id;
    await addSession(
      1,
      "2026-08-31T16:59:59.999999Z",
      "2026-08-31T17:30:00.123456Z",
      ids.childEquipment,
    );
    await addSession(2, "2026-08-31T18:00:00Z", "2026-08-31T19:00:00Z", null);
    ids.openSession = await addSession(
      3,
      "2026-08-31T20:00:00Z",
      null,
      ids.childEquipment,
    );
    ids.crossingDowntime = await addDowntime(
      "2026-08-31T16:59:59.999999Z",
      "2026-08-31T17:10:00.123456Z",
      `${PREFIX}-ACTIVE`,
    );
    ids.zeroDowntime = await addDowntime(
      "2026-08-31T17:20:00.000001Z",
      "2026-08-31T17:20:00.000001Z",
      `${PREFIX}-ACTIVE`,
    );
    await addDowntime(
      "2026-08-31T18:00:00Z",
      "2026-08-31T18:05:00Z",
      `${PREFIX}-INACTIVE`,
    );
    await addDowntime("2026-08-30T00:00:00Z", null, `${PREFIX}-ACTIVE`);
  }

  async function addSession(
    sessionNo: number,
    startedAt: string,
    endedAt: string | null,
    equipmentId: bigint | null,
  ): Promise<bigint> {
    const rows = await prisma.$queryRaw<{ work_session_id: bigint }[]>(
      Prisma.sql`INSERT INTO production.work_session
        (work_order_id,session_no,equipment_id,terminal_id,started_at,ended_at,
         status_code,idempotency_key)
        VALUES (${ids.order},${sessionNo},${equipmentId},${ids.terminal},
          ${startedAt}::timestamptz,${endedAt}::timestamptz,'ENDED',
          ${`${PREFIX}-${sessionNo}`}) RETURNING work_session_id`,
    );
    return rows[0].work_session_id;
  }

  async function addDowntime(
    startedAt: string,
    endedAt: string | null,
    reasonCode: string,
  ): Promise<bigint> {
    const rows = await prisma.$queryRaw<{ equipment_downtime_id: bigint }[]>(
      Prisma.sql`INSERT INTO maintenance.equipment_downtime
        (equipment_id,started_at,ended_at,reason_code,recorded_by_worker_no)
        VALUES (${ids.childEquipment},${startedAt}::timestamptz,
          ${endedAt}::timestamptz,${reasonCode},${PREFIX})
        RETURNING equipment_downtime_id`,
    );
    return rows[0].equipment_downtime_id;
  }

  async function cleanup(): Promise<void> {
    await prisma.equipment_downtime.deleteMany({
      where: { recorded_by_worker_no: PREFIX },
    });
    await prisma.work_session.deleteMany({
      where: { idempotency_key: { startsWith: PREFIX } },
    });
    await prisma.work_order.deleteMany({
      where: { work_order_no: { startsWith: PREFIX } },
    });
    await prisma.routing_operation.deleteMany({
      where: { operation_name: PREFIX },
    });
    await prisma.routing.deleteMany({
      where: { routing_code: { startsWith: PREFIX } },
    });
    await prisma.process.deleteMany({
      where: { process_code: { startsWith: PREFIX } },
    });
    await prisma.item.deleteMany({
      where: { item_code: { startsWith: PREFIX } },
    });
    await prisma.terminal.deleteMany({
      where: { terminal_code: { startsWith: PREFIX } },
    });
    await prisma.equipment.deleteMany({
      where: { equipment_code: { startsWith: PREFIX } },
    });
    await prisma.production_line.deleteMany({
      where: { line_code: `${PREFIX}-CHILD` },
    });
    await prisma.production_line.deleteMany({
      where: { line_code: `${PREFIX}-PARENT` },
    });
    await prisma.code_value.deleteMany({
      where: { code: { startsWith: PREFIX } },
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
