import { PrismaClient } from "@prisma/client";

import { EQUIPMENT_REFERRERS } from "../src/mdm/equipment/equipment.service";
import { MOLD_REFERRERS } from "../src/mdm/mold/mold.service";
import { SPARE_PART_REFERRERS } from "../src/mdm/spare-part/spare-part.service";

const PREFIX = "E2E-B-I31-M2";
const STARTED_AT = new Date("2026-09-01T01:02:03.123Z");

describe("I-31 M2 보전 실적 물리 계약 (e2e)", () => {
  const prisma = new PrismaClient();
  let equipmentId: bigint;
  let moldId: bigint;
  let sparePartId: bigint;
  let performerId: bigint;

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
    moldId = (
      await prisma.mold.create({
        data: {
          mold_code: PREFIX,
          mold_name: PREFIX,
          status_code: "IN_SERVICE",
          tool_type_code: "MOLD",
          plant_id: plant.plant_id,
        },
      })
    ).mold_id;
    sparePartId = (
      await prisma.spare_part.create({
        data: {
          spare_part_code: PREFIX,
          spare_part_name: PREFIX,
          plant_id: plant.plant_id,
        },
      })
    ).spare_part_id;
    performerId = (
      await prisma.app_user.create({
        data: { login_id: PREFIX, user_name: PREFIX, status_code: "EMPLOYED" },
      })
    ).app_user_id;
  });

  afterAll(async () => {
    try {
      await cleanup();
      const remaining = await Promise.all([
        prisma.maintenance_result.count({
          where: { result_note: { startsWith: PREFIX } },
        }),
        prisma.maintenance_result.count({ where: { created_by: performerId } }),
        prisma.spare_part.count({ where: { spare_part_code: PREFIX } }),
        prisma.mold.count({ where: { mold_code: PREFIX } }),
        prisma.equipment.count({ where: { equipment_code: PREFIX } }),
        prisma.app_user.count({ where: { login_id: PREFIX } }),
        prisma.plant.count({ where: { plant_code: PREFIX } }),
        prisma.business_unit.count({ where: { business_unit_code: PREFIX } }),
        prisma.legal_entity.count({ where: { legal_entity_code: PREFIX } }),
      ]);
      expect(remaining).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("M02 구 writer 형상은 all-null target과 기존 null을 보존하고 가짜 값을 만들지 않는다 — 091", async () => {
    const row = await prisma.maintenance_result.create({
      data: { started_at: STARTED_AT, created_by: performerId },
    });
    expect(row).toMatchObject({
      maintenance_order_id: null,
      result_seq: null,
      action_code: null,
      action_description: null,
      completed_at: null,
      result_code: null,
      target_type_code: null,
      equipment_id: null,
      mold_id: null,
      result_note: null,
      is_outsourced: null,
      reset_counter: null,
      closed: null,
      version_no: 1,
    });
  });

  it("M03 target CHECK는 all-null 구행과 정확한 FK 쌍만 허용한다", async () => {
    const valid = await prisma.maintenance_result.createManyAndReturn({
      data: [
        {
          target_type_code: "EQUIPMENT",
          equipment_id: equipmentId,
          started_at: STARTED_AT,
          result_note: `${PREFIX}-EQUIPMENT`,
        },
        {
          target_type_code: "MOLD",
          mold_id: moldId,
          started_at: STARTED_AT,
          result_note: `${PREFIX}-MOLD`,
        },
      ],
    });
    expect(valid.map((row) => row.target_type_code).sort()).toEqual(
      ["EQUIPMENT", "MOLD"].sort(),
    );
    for (const invalid of [
      { target_type_code: "EQUIPMENT" },
      { equipment_id: equipmentId },
      { target_type_code: "MOLD", equipment_id: equipmentId, mold_id: moldId },
    ]) {
      await expect(
        prisma.maintenance_result.create({
          data: { ...invalid, started_at: STARTED_AT },
        }),
      ).rejects.toThrow("ck_maintenance_result_target");
    }
  });

  it("M04 line·part를 순서와 numeric(20,6) 정밀도로 결과에 연결한다", async () => {
    const order = await prisma.maintenance_order.create({
      data: {
        maintenance_order_no: `${PREFIX}-ORDER`,
        target_type_code: "EQUIPMENT",
        equipment_id: equipmentId,
        order_type_code: "CORRECTIVE",
        status_code: "ISSUED",
      },
    });
    const item = await prisma.maintenance_order_item.create({
      data: {
        maintenance_order_id: order.maintenance_order_id,
        sequence_no: 1,
        item_name: PREFIX,
        status_code: "PLANNED",
      },
    });
    const result = await prisma.maintenance_result.create({
      data: {
        maintenance_order_id: order.maintenance_order_id,
        target_type_code: "EQUIPMENT",
        equipment_id: equipmentId,
        started_at: STARTED_AT,
        result_note: `${PREFIX}-CHILDREN`,
        performed_by_user_id: performerId,
        is_outsourced: false,
        reset_counter: false,
        closed: false,
        maintenance_result_line: {
          create: {
            sequence_no: 1,
            maintenance_order_item_id: item.maintenance_order_item_id,
            result_code: "CUSTOM_RESULT",
            remarks: "원문",
          },
        },
        maintenance_result_part: {
          create: {
            sequence_no: 1,
            spare_part_id: sparePartId,
            part_name: "교체품",
            used_qty: "12345678901234.123456",
          },
        },
      },
      include: {
        maintenance_result_line: true,
        maintenance_result_part: true,
        performer: true,
      },
    });
    expect(result.maintenance_result_line[0]).toMatchObject({
      maintenance_order_item_id: item.maintenance_order_item_id,
      result_code: "CUSTOM_RESULT",
      remarks: "원문",
    });
    expect(result.maintenance_result_part[0].used_qty.toFixed(6)).toBe(
      "12345678901234.123456",
    );
    expect(result.performer?.app_user_id).toBe(performerId);
  });

  it("M05 equipment·mold·spare 참조 목록이 새 FK를 포함해 DB와 정확히 같다", async () => {
    for (const [target, expected] of [
      ["equipment", EQUIPMENT_REFERRERS],
      ["mold", MOLD_REFERRERS],
      ["spare_part", SPARE_PART_REFERRERS],
    ] as const) {
      const rows = await prisma.$queryRawUnsafe<
        { table: string; column: string }[]
      >(
        `
        SELECT n.nspname || '.' || r.relname AS "table",
               (SELECT a.attname FROM unnest(c.conkey) k
                  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k) AS "column"
        FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.confrelid
        JOIN pg_namespace tn ON tn.oid=t.relnamespace
        JOIN pg_class r ON r.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE c.contype='f' AND tn.nspname='mdm' AND t.relname=$1`,
        target,
      );
      expect(rows.map((row) => `${row.table}.${row.column}`).sort()).toEqual(
        expected.map(([table, column]) => `${table}.${column}`).sort(),
      );
    }
  });

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: PREFIX },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    const results = await prisma.maintenance_result.findMany({
      where: {
        OR: [
          { result_note: { startsWith: PREFIX } },
          { equipment: { equipment_code: PREFIX } },
          { mold: { mold_code: PREFIX } },
          { created_by: { in: userIds } },
        ],
      },
      select: { maintenance_result_id: true },
    });
    const resultIds = results.map((result) => result.maintenance_result_id);
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
    const orderIds = orders.map((order) => order.maintenance_order_id);
    await prisma.maintenance_order_item.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.spare_part.deleteMany({ where: { spare_part_code: PREFIX } });
    await prisma.mold.deleteMany({ where: { mold_code: PREFIX } });
    await prisma.equipment.deleteMany({ where: { equipment_code: PREFIX } });
    await prisma.app_user.deleteMany({ where: { login_id: PREFIX } });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
  }
});
