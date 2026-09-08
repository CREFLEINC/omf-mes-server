import { maintenanceDateRange } from "../src/maintenance/maintenance-calendar";
import { DowntimeSummaryMaintenanceService } from "../src/maintenance/downtime/downtime-summary-maintenance.service";
import type {
  SummaryEquipmentSource,
  SummaryPlantSource,
} from "../src/maintenance/downtime/downtime-summary-source.types";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I32-SUMMARY-MAINT";

describe("I-32 완료 보전 카운트 (e2e)", () => {
  const prisma = new PrismaService();
  const ids: Record<string, bigint> = {};
  let resolver: DowntimeSummaryMaintenanceService;

  beforeAll(async () => {
    await prisma.$connect();
    resolver = new DowntimeSummaryMaintenanceService(prisma);
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

  it("설비 범위에서 완료 실적이 있는 사후·예방 지시를 한 번씩 센다", async () => {
    await expect(resolve(["selected"], true)).resolves.toEqual({
      correctiveMaintenanceCount: 1,
      preventiveMaintenanceCount: 1,
      breakdownsClosedWithoutOrderCount: 1,
    });
  });

  it("공장 범위는 다른 설비와 금형 지시를 포함한다", async () => {
    await expect(resolve(["selected", "other"], false)).resolves.toEqual({
      correctiveMaintenanceCount: 2,
      preventiveMaintenanceCount: 2,
      breakdownsClosedWithoutOrderCount: 2,
    });
  });

  it("복수 실적의 가장 늦은 완료가 기간 밖이면 지시를 제외한다", async () => {
    const counts = await resolve(["selected"], true);
    expect(counts.correctiveMaintenanceCount).toBe(1);
  });

  it("취소 지시도 직접 FK나 BREAKDOWN trigger 흔적이면 미지시 고장에서 뺀다", async () => {
    const counts = await resolve(["selected"], true);
    expect(counts.breakdownsClosedWithoutOrderCount).toBe(1);
  });

  it("범위가 비면 모든 카운트를 0으로 낸다", async () => {
    await expect(resolver.resolve([], [], false)).resolves.toEqual({
      correctiveMaintenanceCount: 0,
      preventiveMaintenanceCount: 0,
      breakdownsClosedWithoutOrderCount: 0,
    });
  });

  async function resolve(
    equipmentKeys: string[],
    narrowed: boolean,
  ): Promise<{
    correctiveMaintenanceCount: number;
    preventiveMaintenanceCount: number;
    breakdownsClosedWithoutOrderCount: number;
  }> {
    const range = maintenanceDateRange("2026-09-01", "2026-09-01", "UTC");
    if (!range.gte || !range.lt) throw new Error("Missing test range");
    const plant: SummaryPlantSource = {
      plantId: ids.plant.toString(),
      businessUnitId: ids.business.toString(),
      timezone: "UTC",
      rangeStartUs: BigInt(range.gte.getTime()) * 1000n,
      rangeEndUs: BigInt(range.lt.getTime()) * 1000n,
    };
    const equipment = equipmentKeys.map((key): SummaryEquipmentSource => ({
      equipmentId: ids[key].toString(),
      equipmentCode: key,
      equipmentName: key,
      plantId: ids.plant.toString(),
      productionLineId: null,
    }));
    return resolver.resolve([plant], equipment, narrowed);
  }

  async function fixtures(): Promise<void> {
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
    ids.plant = (
      await prisma.plant.create({
        data: {
          legal_entity_id: legal.legal_entity_id,
          business_unit_id: business.business_unit_id,
          plant_code: PREFIX,
          plant_name: PREFIX,
          timezone_code: "UTC",
        },
      })
    ).plant_id;
    for (const key of ["selected", "other"] as const)
      ids[key] = (
        await prisma.equipment.create({
          data: {
            plant_id: ids.plant,
            equipment_code: `${PREFIX}-${key}`,
            equipment_name: key,
            equipment_type_code: "MACHINE",
            status_code: "ACTIVE",
          },
        })
      ).equipment_id;
    ids.mold = (
      await prisma.mold.create({
        data: {
          plant_id: ids.plant,
          mold_code: PREFIX,
          mold_name: PREFIX,
          status_code: "ACTIVE",
          tool_type_code: "MOLD",
        },
      })
    ).mold_id;

    const corrective = await addOrder("CORRECTIVE", "DONE", ids.selected);
    await addResult(corrective, 1, "2026-09-01T10:00:00Z");
    await addResult(corrective, 2, "2026-09-01T12:00:00Z");
    const preventive = await addOrder("PREVENTIVE", "DONE", ids.selected);
    await addResult(preventive, 1, "2026-09-01T11:00:00Z");
    const late = await addOrder("CORRECTIVE-LATE", "DONE", ids.selected);
    await addResult(late, 1, "2026-09-01T09:00:00Z");
    await addResult(late, 2, "2026-09-02T00:00:00Z");
    const issued = await addOrder("ISSUED", "ISSUED", ids.selected);
    await addResult(issued, 1, "2026-09-01T09:00:00Z");
    await addOrder("NO-RESULT", "DONE", ids.selected);
    const other = await addOrder("OTHER", "DONE", ids.other);
    await addResult(other, 1, "2026-09-01T14:00:00Z");
    const mold = await addOrder("MOLD", "DONE", null, ids.mold, "PREVENTIVE");
    await addResult(mold, 1, "2026-09-01T15:00:00Z");

    await addBreakdown("FREE", ids.selected);
    const direct = await addBreakdown("DIRECT", ids.selected);
    await addOrder(
      "DIRECT-CANCEL",
      "CANCELLED",
      ids.selected,
      null,
      "CORRECTIVE",
      direct,
    );
    const triggered = await addBreakdown("TRIGGER", ids.selected);
    const triggerOrder = await addOrder(
      "TRIGGER-CANCEL",
      "CANCELLED",
      ids.selected,
    );
    await prisma.maintenance_order_trigger.create({
      data: {
        maintenance_order_id: triggerOrder,
        trigger_type_code: "BREAKDOWN",
        source_id: triggered,
      },
    });
    await addBreakdown("OTHER-EQUIPMENT", ids.other);
    await addBreakdown("OUTSIDE", ids.selected, "2026-09-02T00:00:00Z");
    await addBreakdown("OPEN", ids.selected, null, "IN_PROGRESS");
  }

  async function addOrder(
    suffix: string,
    status: string,
    equipmentId: bigint | null,
    moldId: bigint | null = null,
    type: string = suffix.startsWith("PREVENTIVE")
      ? "PREVENTIVE"
      : "CORRECTIVE",
    breakdownId: bigint | null = null,
  ): Promise<bigint> {
    return (
      await prisma.maintenance_order.create({
        data: {
          maintenance_order_no: `${PREFIX}-${suffix}`,
          target_type_code: moldId === null ? "EQUIPMENT" : "MOLD",
          equipment_id: equipmentId,
          mold_id: moldId,
          breakdown_id: breakdownId,
          order_type_code: type,
          priority_code: "NORMAL",
          status_code: status,
        },
      })
    ).maintenance_order_id;
  }

  async function addResult(
    orderId: bigint,
    sequence: number,
    completedAt: string,
  ): Promise<void> {
    await prisma.maintenance_result.create({
      data: {
        maintenance_order_id: orderId,
        result_seq: sequence,
        action_code: "REPAIR",
        action_description: PREFIX,
        started_at: new Date("2026-09-01T08:00:00Z"),
        completed_at: new Date(completedAt),
        result_code: "DONE",
      },
    });
  }

  async function addBreakdown(
    suffix: string,
    equipmentId: bigint,
    completedAt: string | null = "2026-09-01T13:00:00Z",
    status = "DONE",
  ): Promise<bigint> {
    return (
      await prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-${suffix}`,
          equipment_id: equipmentId,
          reported_at: new Date("2026-09-01T08:00:00Z"),
          description: PREFIX,
          status_code: status,
          completed_at: completedAt === null ? null : new Date(completedAt),
        },
      })
    ).breakdown_id;
  }

  async function cleanup(): Promise<void> {
    const orders = await prisma.maintenance_order.findMany({
      where: { maintenance_order_no: { startsWith: PREFIX } },
      select: { maintenance_order_id: true },
    });
    const orderIds = orders.map((row) => row.maintenance_order_id);
    await prisma.maintenance_order_trigger.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_result.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.breakdown.deleteMany({
      where: { breakdown_no: { startsWith: PREFIX } },
    });
    await prisma.mold.deleteMany({ where: { mold_code: PREFIX } });
    await prisma.equipment.deleteMany({
      where: { equipment_code: { startsWith: PREFIX } },
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
