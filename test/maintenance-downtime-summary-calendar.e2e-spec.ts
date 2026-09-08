import { maintenanceDateRange } from "../src/maintenance/maintenance-calendar";
import { DowntimeSummaryCalendarService } from "../src/maintenance/downtime/downtime-summary-calendar.service";
import type {
  SummaryEquipmentSource,
  SummaryPlantSource,
} from "../src/maintenance/downtime/downtime-summary-source.types";
import { PrismaService } from "../src/prisma/prisma.service";

const PREFIX = "E2E-B-I32-SUMMARY-CALENDAR";
const HOUR_US = 3_600_000_000n;

describe("I-32 계획 비가동 (e2e)", () => {
  const prisma = new PrismaService();
  const ids: Record<string, bigint> = {};
  const sources = new Map<string, SummaryEquipmentSource>();
  const timezones = new Map<string, string>();
  let resolver: DowntimeSummaryCalendarService;

  beforeAll(async () => {
    await prisma.$connect();
    resolver = new DowntimeSummaryCalendarService(prisma);
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

  it("HOLIDAY의 겹치는 활성 교대를 설비별 합집합으로 더한다", async () => {
    await expect(resolve(["a1", "a2"], "2026-09-01")).resolves.toBe(
      12n * HOUR_US,
    );
  });

  it("WORKING은 계획 비가동 0이다", async () => {
    await expect(resolve(["a1"], "2026-09-02")).resolves.toBe(0n);
  });

  it("PARTIAL은 정상 교대 합집합 중 가동창 밖만 센다", async () => {
    await expect(resolve(["a1"], "2026-09-03")).resolves.toBe(2n * HOUR_US);
  });

  it("적용일 전에는 부모 그룹, 적용일부터 가까운 자식 그룹 캘린더를 쓴다", async () => {
    await expect(resolve(["a1"], "2026-09-03")).resolves.toBe(2n * HOUR_US);
    await expect(resolve(["a1"], "2026-09-04")).resolves.toBe(0n);
  });

  it("그룹이 없는 설비는 공장 캘린더를 쓴다", async () => {
    await expect(resolve(["plain"], "2026-09-01")).resolves.toBe(6n * HOUR_US);
  });

  it("가까운 적용의 캘린더가 비활성이면 상위 값을 지어내지 않는다", async () => {
    await expect(resolve(["a1"], "2026-09-06")).resolves.toBeNull();
  });

  it("선택 캘린더의 날짜행이 없으면 값을 생략한다", async () => {
    await expect(resolve(["a1"], "2026-09-05")).resolves.toBeNull();
  });

  it("활성 교대가 없으면 값을 생략한다", async () => {
    await expect(resolve(["b1"], "2026-09-01")).resolves.toBeNull();
  });

  it("조회 첫날에 이어지는 전날 야간 휴무 교대를 포함한다", async () => {
    await expect(resolve(["c1"], "2026-09-01")).resolves.toBe(2n * HOUR_US);
  });

  it("야간 교대의 전날 캘린더가 비면 값을 생략한다", async () => {
    await expect(resolve(["c1"], "2026-09-03")).resolves.toBeNull();
  });

  it("공장 로컬 DST 봄 전환일의 실제 3시간 교대를 보존한다", async () => {
    await expect(resolve(["d1"], "2026-03-08")).resolves.toBe(3n * HOUR_US);
  });

  it("공장 로컬 DST 가을 전환일의 실제 5시간 교대를 보존한다", async () => {
    await expect(resolve(["d1"], "2026-11-01")).resolves.toBe(5n * HOUR_US);
  });

  async function resolve(
    keys: string[],
    from: string,
    to: string = from,
  ): Promise<bigint | null> {
    const equipment = keys.map((key) => {
      const source = sources.get(key);
      if (!source) throw new Error(`Missing equipment source: ${key}`);
      return source;
    });
    const plants: SummaryPlantSource[] = [
      ...new Set(equipment.map((item) => item.plantId)),
    ].map((plantId) => {
      const timezone = timezones.get(plantId);
      if (!timezone) throw new Error("Missing test timezone");
      const range = maintenanceDateRange(from, to, timezone);
      if (!range.gte || !range.lt) throw new Error("Missing test range");
      return {
        plantId,
        businessUnitId: ids.business.toString(),
        timezone,
        rangeStartUs: BigInt(range.gte.getTime()) * 1000n,
        rangeEndUs: BigInt(range.lt.getTime()) * 1000n,
      };
    });
    return resolver.resolve(plants, equipment, from, to);
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
    for (const [key, timezone] of [
      ["a", "UTC"],
      ["b", "UTC"],
      ["c", "UTC"],
      ["d", "America/New_York"],
    ] as const) {
      const plant = await prisma.plant.create({
        data: {
          legal_entity_id: legal.legal_entity_id,
          business_unit_id: business.business_unit_id,
          plant_code: `${PREFIX}-${key}`,
          plant_name: key,
          timezone_code: timezone,
        },
      });
      ids[`plant${key}`] = plant.plant_id;
      timezones.set(plant.plant_id.toString(), timezone);
    }
    ids.parent = await addLine("PARENT", ids.planta);
    ids.child = await addLine("CHILD", ids.planta, ids.parent);
    await addEquipment("a1", ids.planta, ids.child);
    await addEquipment("a2", ids.planta, ids.child);
    await addEquipment("plain", ids.planta, null);
    await addEquipment("b1", ids.plantb, null);
    await addEquipment("c1", ids.plantc, null);
    await addEquipment("d1", ids.plantd, null);
    await addShift("A1", ids.planta, "08:00", "12:00");
    await addShift("A2", ids.planta, "10:00", "14:00");
    await addShift("OFF", ids.planta, "00:00", "00:00", false, false);
    await addShift("N", ids.plantc, "22:00", "02:00", true);
    await addShift("DST", ids.plantd, "00:00", "04:00");

    const plantA = await addCalendar("PLANT-A");
    const parent = await addCalendar("PARENT");
    const child = await addCalendar("CHILD");
    const inactive = await addCalendar("INACTIVE", false);
    const plantB = await addCalendar("PLANT-B");
    const plantC = await addCalendar("PLANT-C");
    const plantD = await addCalendar("PLANT-D");
    await apply(plantA, "PLANT", ids.planta, "2026-01-01");
    await apply(parent, "EQUIPMENT_GROUP", ids.parent, "2026-01-01");
    await apply(child, "EQUIPMENT_GROUP", ids.child, "2026-09-04");
    await apply(inactive, "EQUIPMENT_GROUP", ids.child, "2026-09-06");
    await apply(plantB, "PLANT", ids.plantb, "2026-01-01");
    await apply(plantC, "PLANT", ids.plantc, "2026-01-01");
    await apply(plantD, "PLANT", ids.plantd, "2026-01-01");

    await addDay(plantA, "2026-09-01", "HOLIDAY");
    await addDay(parent, "2026-09-01", "HOLIDAY");
    await addDay(parent, "2026-09-02", "WORKING");
    await addDay(parent, "2026-09-03", "PARTIAL", "09:00", "13:00");
    await addDay(parent, "2026-09-04", "HOLIDAY");
    await addDay(child, "2026-09-04", "WORKING");
    await addDay(inactive, "2026-09-06", "HOLIDAY");
    await addDay(plantB, "2026-09-01", "HOLIDAY");
    await addDay(plantC, "2026-08-31", "HOLIDAY");
    await addDay(plantC, "2026-09-01", "WORKING");
    await addDay(plantC, "2026-09-03", "WORKING");
    await addDay(plantD, "2026-03-08", "HOLIDAY");
    await addDay(plantD, "2026-11-01", "HOLIDAY");
  }

  async function addLine(
    code: string,
    plantId: bigint,
    parentId: bigint | null = null,
  ): Promise<bigint> {
    return (
      await prisma.production_line.create({
        data: {
          plant_id: plantId,
          parent_line_id: parentId,
          line_code: `${PREFIX}-${code}`,
          line_name: code,
        },
      })
    ).production_line_id;
  }

  async function addEquipment(
    key: string,
    plantId: bigint,
    lineId: bigint | null,
  ): Promise<void> {
    const row = await prisma.equipment.create({
      data: {
        plant_id: plantId,
        production_line_id: lineId,
        equipment_code: `${PREFIX}-${key}`,
        equipment_name: key,
        equipment_type_code: "MACHINE",
        status_code: "ACTIVE",
      },
    });
    sources.set(key, {
      equipmentId: row.equipment_id.toString(),
      equipmentCode: row.equipment_code,
      equipmentName: row.equipment_name,
      plantId: plantId.toString(),
      productionLineId: lineId?.toString() ?? null,
    });
  }

  async function addShift(
    code: string,
    plantId: bigint,
    start: string,
    end: string,
    crossesMidnight = false,
    isActive = true,
  ): Promise<void> {
    await prisma.shift.create({
      data: {
        plant_id: plantId,
        shift_code: `${PREFIX}-${code}`,
        shift_name: code,
        start_time: new Date(`1970-01-01T${start}:00Z`),
        end_time: new Date(`1970-01-01T${end}:00Z`),
        crosses_midnight: crossesMidnight,
        is_active: isActive,
      },
    });
  }

  async function addCalendar(code: string, isActive = true): Promise<bigint> {
    return (
      await prisma.work_calendar.create({
        data: {
          calendar_code: `${PREFIX}-${code}`,
          calendar_name: code,
          is_active: isActive,
        },
      })
    ).work_calendar_id;
  }

  async function apply(
    calendarId: bigint,
    targetType: string,
    targetId: bigint,
    effectiveFrom: string,
  ): Promise<void> {
    await prisma.work_calendar_application.create({
      data: {
        work_calendar_id: calendarId,
        target_type_code: targetType,
        target_id: targetId,
        effective_from: new Date(`${effectiveFrom}T00:00:00Z`),
      },
    });
  }

  async function addDay(
    calendarId: bigint,
    date: string,
    type: string,
    start?: string,
    end?: string,
  ): Promise<void> {
    await prisma.work_calendar_day.create({
      data: {
        work_calendar_id: calendarId,
        calendar_date: new Date(`${date}T00:00:00Z`),
        day_type_code: type,
        work_start_time:
          start === undefined ? null : new Date(`1970-01-01T${start}:00Z`),
        work_end_time:
          end === undefined ? null : new Date(`1970-01-01T${end}:00Z`),
      },
    });
  }

  async function cleanup(): Promise<void> {
    const calendars = await prisma.work_calendar.findMany({
      where: { calendar_code: { startsWith: PREFIX } },
      select: { work_calendar_id: true },
    });
    const calendarIds = calendars.map((row) => row.work_calendar_id);
    await prisma.work_calendar_day.deleteMany({
      where: { work_calendar_id: { in: calendarIds } },
    });
    await prisma.work_calendar_application.deleteMany({
      where: { work_calendar_id: { in: calendarIds } },
    });
    await prisma.work_calendar.deleteMany({
      where: { work_calendar_id: { in: calendarIds } },
    });
    await prisma.shift.deleteMany({
      where: { shift_code: { startsWith: PREFIX } },
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
