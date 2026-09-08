import { PrismaClient } from "@prisma/client";

const PREFIX = "E2E-B-I31-M1";
const LARGE_SHOT = 2_147_483_648n;
const SAFE_MAX_SHOT = 9_007_199_254_740_991n;

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  datetime_precision: number | null;
}

describe("I-31 M1 보전 지시·촉발 물리 계약 (e2e)", () => {
  const prisma = new PrismaClient();
  let equipmentId: bigint;
  let assigneeId: bigint;
  let issuerId: bigint;
  let cancellerId: bigint;

  beforeAll(async () => {
    await cleanup();
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
    const plant = await prisma.plant.create({
      data: {
        plant_code: PREFIX,
        plant_name: PREFIX,
        legal_entity_id: legal.legal_entity_id,
        business_unit_id: business.business_unit_id,
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    equipmentId = (
      await prisma.equipment.create({
        data: {
          equipment_code: PREFIX,
          equipment_name: PREFIX,
          equipment_type_code: "MACHINE",
          status_code: "ACTIVE",
          plant_id: plant.plant_id,
        },
      })
    ).equipment_id;
    [assigneeId, issuerId, cancellerId] = await Promise.all(
      ["ASSIGNEE", "ISSUER", "CANCELLER"].map(
        async (suffix) =>
          (
            await prisma.app_user.create({
              data: {
                login_id: `${PREFIX}-${suffix}`,
                user_name: suffix,
                status_code: "EMPLOYED",
              },
            })
          ).app_user_id,
      ),
    );
  });

  afterAll(async () => {
    try {
      await cleanup();
      const remaining = await Promise.all([
        prisma.maintenance_order.count({
          where: { maintenance_order_no: { startsWith: PREFIX } },
        }),
        prisma.equipment.count({ where: { equipment_code: PREFIX } }),
        prisma.app_user.count({ where: { login_id: { startsWith: PREFIX } } }),
        prisma.plant.count({ where: { plant_code: PREFIX } }),
        prisma.business_unit.count({ where: { business_unit_code: PREFIX } }),
        prisma.legal_entity.count({ where: { legal_entity_code: PREFIX } }),
      ]);
      expect(remaining).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("M01 신규 8칸은 nullable·무기본값이고 priority만 완화한다", async () => {
    const columns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,column_default,datetime_precision
      FROM information_schema.columns
      WHERE table_schema='maintenance' AND table_name='maintenance_order'
        AND column_name IN ('planned_date','base_date','order_note','assignee_user_id',
          'issued_by','issued_at','cancelled_at','cancelled_by','priority_code')`;
    expect(columns).toHaveLength(9);
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );
    for (const name of [
      "planned_date",
      "base_date",
      "order_note",
      "assignee_user_id",
      "issued_by",
      "issued_at",
      "cancelled_at",
      "cancelled_by",
    ]) {
      expect(byName[name]).toMatchObject({
        is_nullable: "YES",
        column_default: null,
      });
    }
    expect(byName.priority_code).toMatchObject({
      data_type: "character varying",
      is_nullable: "YES",
      column_default: null,
    });
    expect(byName.planned_date.data_type).toBe("date");
    expect(byName.base_date.data_type).toBe("date");
    for (const name of ["issued_at", "cancelled_at"]) {
      expect(byName[name]).toMatchObject({
        data_type: "timestamp with time zone",
        datetime_precision: 6,
      });
    }
  });

  it("M02 구 writer 형상은 새 값을 발명하지 않고 기존 필드를 보존한다 — 091", async () => {
    const order = await createOrder("LEGACY");
    expect(order).toMatchObject({
      target_type_code: "EQUIPMENT",
      equipment_id: equipmentId,
      order_type_code: "CORRECTIVE",
      status_code: "ISSUED",
      priority_code: null,
      planned_date: null,
      base_date: null,
      order_note: null,
      assignee_user_id: null,
      issued_by: null,
      issued_at: null,
      cancelled_at: null,
      cancelled_by: null,
    });
  });

  it("M03 trigger 두 행과 int32 초과 snapshot을 한 지시에 무손실 저장한다", async () => {
    const order = await createOrder("TRIGGERS", {
      assignee_user_id: assigneeId,
      issued_by: issuerId,
      cancelled_by: cancellerId,
    });
    await prisma.maintenance_order_trigger.createMany({
      data: [
        {
          maintenance_order_id: order.maintenance_order_id,
          trigger_type_code: "BREAKDOWN",
          source_id: 101n,
          shot_count_at_due: LARGE_SHOT,
        },
        {
          maintenance_order_id: order.maintenance_order_id,
          trigger_type_code: "PM_DUE",
          source_id: null,
          shot_count_at_due: SAFE_MAX_SHOT,
          guaranteed_shot_count_at_due: SAFE_MAX_SHOT,
        },
      ],
    });

    const stored = await prisma.maintenance_order.findUniqueOrThrow({
      where: { maintenance_order_id: order.maintenance_order_id },
      include: {
        maintenance_order_trigger: {
          orderBy: { maintenance_order_trigger_id: "asc" },
        },
        assignee_user: true,
        issuer: true,
        canceller: true,
      },
    });
    expect(stored.maintenance_order_trigger).toHaveLength(2);
    expect(
      stored.maintenance_order_trigger.map((row) => row.shot_count_at_due),
    ).toEqual([LARGE_SHOT, SAFE_MAX_SHOT]);
    expect(
      stored.maintenance_order_trigger[1].guaranteed_shot_count_at_due,
    ).toBe(SAFE_MAX_SHOT);
    expect(stored.assignee_user?.app_user_id).toBe(assigneeId);
    expect(stored.issuer?.app_user_id).toBe(issuerId);
    expect(stored.canceller?.app_user_id).toBe(cancellerId);
  });

  it("M04 parent UNIQUE는 제거되고 trigger FK·조회 인덱스는 남는다", async () => {
    const constraints = await prisma.$queryRaw<
      { name: string; definition: string }[]
    >`
      SELECT conname AS name,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid='maintenance.maintenance_order_trigger'::regclass
      ORDER BY conname`;
    expect(constraints).toEqual([
      {
        name: "ck_maintenance_order_trigger_shots",
        definition:
          "CHECK ((((shot_count_at_due IS NULL) OR (shot_count_at_due >= 0)) AND ((guaranteed_shot_count_at_due IS NULL) OR (guaranteed_shot_count_at_due >= 0))))",
      },
      {
        name: "maintenance_order_trigger_maintenance_order_id_fkey",
        definition:
          "FOREIGN KEY (maintenance_order_id) REFERENCES maintenance.maintenance_order(maintenance_order_id)",
      },
      {
        name: "maintenance_order_trigger_pkey",
        definition: "PRIMARY KEY (maintenance_order_trigger_id)",
      },
    ]);
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='maintenance' AND tablename='maintenance_order_trigger'
      ORDER BY indexname`;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "ix_maintenance_order_trigger_order",
      "ix_maintenance_order_trigger_source",
      "maintenance_order_trigger_pkey",
    ]);
  });

  async function createOrder(
    suffix: string,
    extra: {
      assignee_user_id?: bigint;
      issued_by?: bigint;
      cancelled_by?: bigint;
    } = {},
  ) {
    return prisma.maintenance_order.create({
      data: {
        maintenance_order_no: `${PREFIX}-${suffix}`,
        target_type_code: "EQUIPMENT",
        equipment_id: equipmentId,
        order_type_code: "CORRECTIVE",
        status_code: "ISSUED",
        ...extra,
      },
    });
  }

  async function cleanup(): Promise<void> {
    const orders = await prisma.maintenance_order.findMany({
      where: { maintenance_order_no: { startsWith: PREFIX } },
      select: { maintenance_order_id: true },
    });
    const orderIds = orders.map((order) => order.maintenance_order_id);
    await prisma.maintenance_order_trigger.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.equipment.deleteMany({ where: { equipment_code: PREFIX } });
    await prisma.app_user.deleteMany({
      where: { login_id: { startsWith: PREFIX } },
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
