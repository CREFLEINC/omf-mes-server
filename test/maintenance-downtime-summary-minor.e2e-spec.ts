import { PrismaClient } from "@prisma/client";

import { DowntimeSummaryMinorService } from "../src/maintenance/downtime/downtime-summary-minor.service";
import type { SummaryPlantSource } from "../src/maintenance/downtime/downtime-summary-source.types";

const PREFIX = "E2E-B-I32-SUMMARY-MINOR";

describe("I-32 경미 정지 정책 (e2e)", () => {
  const prisma = new PrismaClient();
  const ids: Record<string, bigint> = {};
  let resolver: DowntimeSummaryMinorService;
  let plants: SummaryPlantSource[];

  beforeAll(async () => {
    await prisma.$connect();
    resolver = new DowntimeSummaryMinorService(prisma);
    await cleanup();
    plants = await fixtures();
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("공장 정책이 사업부·전체보다 우선한다", async () => {
    await addPolicy({ value: "3", effectiveFrom: "2026-01-01" });
    await addPolicy({
      businessUnitId: ids.business,
      value: "4",
      effectiveFrom: "2026-01-01",
    });
    await addPolicy({
      plantId: ids.plantA,
      value: "2.5",
      effectiveFrom: "2026-01-01",
    });

    const result = await resolver.resolve([plants[0]], "2026-09-01");

    expect(result.byPlant.get(ids.plantA.toString())).toBe(150_000_000n);
    expect(result.minorStopThresholdMinutes).toBe(2.5);
  });

  it("같은 범위면 늦게 시작하고 나중에 만든 정책이 이긴다", async () => {
    await addPolicy({
      businessUnitId: ids.business,
      plantId: ids.plantA,
      value: "2.25",
      effectiveFrom: "2026-02-01",
    });
    await addPolicy({
      plantId: ids.plantA,
      value: "2.75",
      effectiveFrom: "2026-02-01",
    });

    const result = await resolver.resolve([plants[0]], "2026-09-01");
    expect(result.minorStopThresholdMinutes).toBe(2.75);
  });

  it("평가일에 유효하지 않은 정책과 ITEM·PROCESS 정책을 뺀다", async () => {
    await addPolicy({
      plantId: ids.plantB,
      value: "1",
      effectiveFrom: "2026-09-02",
    });
    await addPolicy({
      itemId: ids.item,
      value: "1.5",
      effectiveFrom: "2026-01-01",
    });

    const isolated = { ...plants[1], businessUnitId: null };
    const result = await resolver.resolve([isolated], "2026-09-01");
    expect(result.byPlant.get(ids.plantB.toString())).toBe(180_000_000n);
    expect(result.minorStopThresholdMinutes).toBe(3);
  });

  it("정책이 없을 때만 5분을 쓴다", async () => {
    const isolated = { ...plants[1], businessUnitId: null };
    await prisma.operation_policy.deleteMany({
      where: { created_by: ids.user },
    });

    const result = await resolver.resolve([isolated], "2026-09-01");
    expect(result.byPlant.get(isolated.plantId)).toBe(300_000_000n);
    expect(result.minorStopThresholdMinutes).toBe(5);
  });

  it("숫자 값이 손상된 정책을 정책 부재로 오인하지 않는다", async () => {
    const corrupt = await prisma.operation_policy.create({
      data: {
        policy_code: "MINOR_STOP_THRESHOLD_MINUTES",
        plant_id: ids.plantA,
        value_text: "corrupt",
        effective_from: new Date("2026-01-01T00:00:00Z"),
        created_by: ids.user,
      },
    });

    await expect(resolver.resolve([plants[0]], "2026-09-01")).rejects.toThrow(
      "Invalid minor stop threshold policy",
    );
    await prisma.operation_policy.delete({
      where: { operation_policy_id: corrupt.operation_policy_id },
    });
  });

  it("여러 공장의 임계가 다르면 행별 값은 유지하고 scalar는 null이다", async () => {
    await addPolicy({
      plantId: ids.plantA,
      value: "0.000001",
      effectiveFrom: "2026-01-01",
    });
    await addPolicy({
      plantId: ids.plantB,
      value: "2",
      effectiveFrom: "2026-01-01",
    });

    const result = await resolver.resolve(plants, "2026-09-01");
    expect(result.byPlant.get(ids.plantA.toString())).toBe(60n);
    expect(result.byPlant.get(ids.plantB.toString())).toBe(120_000_000n);
    expect(result.minorStopThresholdMinutes).toBeNull();
  });

  it("공장이 없으면 임계를 지어내지 않는다", async () => {
    await expect(resolver.resolve([], "2026-09-01")).resolves.toEqual({
      byPlant: new Map(),
      minorStopThresholdMinutes: null,
    });
  });

  async function fixtures(): Promise<SummaryPlantSource[]> {
    ids.user = (
      await prisma.app_user.create({
        data: { login_id: PREFIX, user_name: PREFIX },
      })
    ).app_user_id;
    const legal = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: PREFIX,
        country_code: "VN",
        timezone_code: "UTC",
      },
    });
    const business = await prisma.business_unit.create({
      data: {
        legal_entity_id: legal.legal_entity_id,
        business_unit_code: PREFIX,
        business_unit_name: PREFIX,
      },
    });
    ids.business = business.business_unit_id;
    for (const name of ["A", "B"] as const) {
      const plant = await prisma.plant.create({
        data: {
          legal_entity_id: legal.legal_entity_id,
          business_unit_id: business.business_unit_id,
          plant_code: `${PREFIX}-${name}`,
          plant_name: name,
          timezone_code: "UTC",
        },
      });
      ids[`plant${name}`] = plant.plant_id;
    }
    ids.item = (
      await prisma.item.create({
        data: {
          item_code: PREFIX,
          item_name: PREFIX,
          item_type_code: "FINISHED_GOODS",
          base_uom_id: (await prisma.uom.findFirstOrThrow()).uom_id,
          lot_controlled: false,
        },
      })
    ).item_id;
    return [ids.plantA, ids.plantB].map((plantId) => ({
      plantId: plantId.toString(),
      businessUnitId: business.business_unit_id.toString(),
      timezone: "UTC",
      rangeStartUs: 0n,
      rangeEndUs: 1n,
    }));
  }

  async function addPolicy(input: {
    businessUnitId?: bigint;
    plantId?: bigint;
    itemId?: bigint;
    value: string;
    effectiveFrom: string;
  }): Promise<void> {
    await prisma.operation_policy.create({
      data: {
        policy_code: "MINOR_STOP_THRESHOLD_MINUTES",
        business_unit_id: input.businessUnitId,
        plant_id: input.plantId,
        item_id: input.itemId,
        value_numeric: input.value,
        effective_from: new Date(`${input.effectiveFrom}T00:00:00Z`),
        created_by: ids.user,
      },
    });
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: PREFIX },
      select: { app_user_id: true },
    });
    await prisma.operation_policy.deleteMany({
      where: { created_by: { in: users.map((user) => user.app_user_id) } },
    });
    await prisma.item.deleteMany({ where: { item_code: PREFIX } });
    await prisma.plant.deleteMany({
      where: { plant_code: { startsWith: PREFIX } },
    });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
    await prisma.app_user.deleteMany({ where: { login_id: PREFIX } });
  }
});
