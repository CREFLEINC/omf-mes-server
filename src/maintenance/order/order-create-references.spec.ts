import { Prisma } from "@prisma/client";

import { ContractException } from "../../common/errors";
import {
  MaintenanceOrderCreate,
  checkMaintenanceOrderCreate,
} from "./order-create-input";
import { resolveMaintenanceOrderReferences } from "./order-create-references";

const equipmentInput = (override: Partial<MaintenanceOrderCreate> = {}) =>
  checkMaintenanceOrderCreate({
    targetTypeCode: "EQUIPMENT",
    targetId: 1,
    plannedDate: "2026-09-09",
    assigneeUserId: 2,
    items: [{ sequenceNo: 1, inspectionItemId: 31 }],
    triggers: [{ triggerTypeCode: "PM_DUE" }],
    baseDate: "2026-09-01",
    ...override,
  });

const moldInput = (override: Partial<MaintenanceOrderCreate> = {}) =>
  checkMaintenanceOrderCreate({
    targetTypeCode: "MOLD",
    targetId: 9,
    plannedDate: "2026-09-09",
    assigneeUserId: 2,
    itemNames: ["분해 청소"],
    triggers: [
      {
        triggerTypeCode: "PM_DUE",
        pmDueAxisCode: "SHOT",
        shotCountAtDue: 100,
        guaranteedShotCountAtDue: 100,
      },
    ],
    baseDate: "2026-09-01",
    ...override,
  });

describe("maintenance order create references", () => {
  it("설비를 먼저 NO KEY UPDATE 잠그고 유효 부여를 확정한다", async () => {
    const setup = fake();

    await expect(
      resolveMaintenanceOrderReferences(setup.tx, equipmentInput()),
    ).resolves.toEqual({ plantId: 7n, equipmentId: 1n, moldId: null });
    expect(setup.rawSql[0]).toContain("mdm.equipment");
    expect(setup.rawSql[0]).toContain("FOR NO KEY UPDATE");
    expect(setup.rawSql).toContainEqual(
      expect.stringMatching(/equipment_inspection_item[\s\S]*FOR SHARE/),
    );
  });

  it("고장·불합격 원천을 종류와 ID 순으로 SHARE 잠그고 대상·상태를 검증한다", async () => {
    const setup = fake({
      breakdownRows: [
        { source_id: 11n, equipment_id: 1n, state_code: "HANDLING" },
      ],
      inspectionRows: [
        { source_id: 12n, equipment_id: 1n, state_code: "FAIL" },
      ],
    });
    const input = equipmentInput({
      triggers: [
        { triggerTypeCode: "BREAKDOWN", sourceId: 11 },
        { triggerTypeCode: "INSPECTION_NG", sourceId: 12 },
      ],
      baseDate: null,
    });

    await resolveMaintenanceOrderReferences(setup.tx, input);
    expect(setup.rawSql).toContainEqual(
      expect.stringMatching(
        /maintenance\.breakdown[\s\S]*ORDER BY breakdown_id FOR SHARE/,
      ),
    );
    expect(setup.rawSql).toContainEqual(
      expect.stringMatching(
        /equipment_inspection[\s\S]*ORDER BY equipment_inspection_id FOR SHARE/,
      ),
    );
  });

  it("없는 사용 중 담당 계정은 대상 잠금 뒤 400으로 거부한다", async () => {
    const setup = fake({ assignee: null });

    const error = await rejected(
      resolveMaintenanceOrderReferences(setup.tx, equipmentInput()),
    );
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(400);
    expect((error as ContractException).errors[0]).toMatchObject({
      field: "assigneeUserId",
      code: "INVALID",
    });
    expect(setup.assignmentReader).not.toHaveBeenCalled();
  });

  it.each([
    ["폐기", { status_code: "DISPOSED" }, "STATE_LOCKED"],
    ["사용 중지", { is_active: false }, "INVALID"],
  ])("%s 대상은 발행하지 않는다", async (_name, override, code) => {
    const setup = fake({ equipment: { ...equipmentTarget(), ...override } });

    const error = await rejected(
      resolveMaintenanceOrderReferences(setup.tx, equipmentInput()),
    );
    expect((error as ContractException).errors[0].code).toBe(code);
    expect(setup.userReader).not.toHaveBeenCalled();
  });

  it("원천 오류는 필터 후 번호가 아니라 원 요청 trigger index를 가리킨다", async () => {
    const setup = fake({
      breakdownRows: [
        { source_id: 11n, equipment_id: 8n, state_code: "RECEIVED" },
      ],
    });
    const input = equipmentInput({
      triggers: [
        { triggerTypeCode: "PM_DUE" },
        { triggerTypeCode: "BREAKDOWN", sourceId: 11 },
      ],
      baseDate: null,
    });

    const error = await rejected(
      resolveMaintenanceOrderReferences(setup.tx, input),
    );
    expect((error as ContractException).errors[0]).toMatchObject({
      field: "triggers[1].sourceId",
      code: "INVALID",
    });
  });

  it("이미 지시에 연결된 설비 원천은 422로 거부한다", async () => {
    const setup = fake({
      breakdownRows: [
        { source_id: 11n, equipment_id: 1n, state_code: "RECEIVED" },
      ],
      linked: [{ trigger_type_code: "BREAKDOWN", source_id: 11n }],
    });
    const input = equipmentInput({
      triggers: [{ triggerTypeCode: "BREAKDOWN", sourceId: 11 }],
      baseDate: null,
    });

    const error = await rejected(
      resolveMaintenanceOrderReferences(setup.tx, input),
    );
    expect((error as ContractException).getStatus()).toBe(422);
  });

  it("금형 PM 사실과 제공된 스냅샷이 같으면 현재 값을 바꾸지 않고 승인한다", async () => {
    const setup = fake({ useMold: true });

    await expect(
      resolveMaintenanceOrderReferences(
        setup.tx,
        moldInput(),
        new Date("2026-09-08T00:00:00Z"),
      ),
    ).resolves.toEqual({ plantId: 7n, equipmentId: null, moldId: 9n });
    expect(setup.rawSql[0]).toContain("FOR NO KEY UPDATE OF m");
    expect(setup.assignmentReader).not.toHaveBeenCalled();
  });

  it.each([
    ["pmDueAxisCode", { pmDueAxisCode: "DATE" as const }],
    ["shotCountAtDue", { shotCountAtDue: 99 }],
    ["guaranteedShotCountAtDue", { guaranteedShotCountAtDue: null }],
  ])("stale %s 스냅샷은 422와 해당 field를 반환한다", async (name, trigger) => {
    const setup = fake({ useMold: true });
    const input = moldInput({
      triggers: [{ triggerTypeCode: "PM_DUE", ...trigger }],
    });

    const error = await rejected(
      resolveMaintenanceOrderReferences(setup.tx, input),
    );
    expect((error as ContractException).getStatus()).toBe(422);
    expect((error as ContractException).errors[0].field).toBe(
      `triggers[0].${name}`,
    );
  });

  it("도래하지 않은 금형과 이미 열린 금형 PM은 각각 422다", async () => {
    const notDue = fake({
      useMold: true,
      mold: { ...moldTarget(), current_shot_count: 99n },
    });
    await expect(
      resolveMaintenanceOrderReferences(notDue.tx, moldInput()),
    ).rejects.toMatchObject({ status: 422 });

    const open = fake({ useMold: true, openOrders: 1 });
    await expect(
      resolveMaintenanceOrderReferences(open.tx, moldInput()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("잘못된 공장 timezone은 UTC로 추측하지 않고 내부 오류로 전파한다", async () => {
    const setup = fake({
      useMold: true,
      mold: { ...moldTarget(), timezone_code: "Bad/Timezone" },
    });

    await expect(
      resolveMaintenanceOrderReferences(setup.tx, moldInput()),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

const equipmentTarget = () => ({
  equipment_id: 1n,
  plant_id: 7n,
  production_line_id: null,
  status_code: "IN_SERVICE",
  is_active: true,
});

const moldTarget = () => ({
  mold_id: 9n,
  plant_id: 7n,
  timezone_code: "UTC",
  status_code: "IN_SERVICE",
  is_active: true,
  pm_trigger_type_code: "SHOT",
  guaranteed_shot_count: 100n,
  current_shot_count: 100n,
  last_pm_date: null,
  pm_cycle_interval: null,
  pm_cycle_unit_code: null,
});

interface FakeOptions {
  useMold?: boolean;
  equipment?: ReturnType<typeof equipmentTarget>;
  mold?: ReturnType<typeof moldTarget>;
  assignee?: { app_user_id: bigint } | null;
  breakdownRows?: unknown[];
  inspectionRows?: unknown[];
  linked?: unknown[];
  openOrders?: number;
}

function fake(options: FakeOptions = {}) {
  const rawSql: string[] = [];
  const assignmentReader = jest.fn(async () => [
    {
      equipment_inspection_item_assignment_id: 101n,
      equipment_inspection_item_id: 31n,
      is_active: true,
    },
  ]);
  const userReader = jest.fn(async () =>
    options.assignee === undefined ? { app_user_id: 2n } : options.assignee,
  );
  const tx = {
    app_user: { findFirst: userReader },
    equipment_inspection_item_assignment: { findMany: assignmentReader },
    equipment_group_inspection_item: { findMany: jest.fn(async () => []) },
    production_line: { findUnique: jest.fn(async () => null) },
    maintenance_order_trigger: {
      findMany: jest.fn(async () => options.linked ?? []),
    },
    maintenance_order: {
      count: jest.fn(async () => options.openOrders ?? 0),
    },
    $queryRaw: jest.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
      const sql = Array.isArray(query)
        ? query.join("?")
        : (query as Prisma.Sql).strings.join("?");
      rawSql.push(sql);
      if (sql.includes("FROM mdm.equipment_inspection_item"))
        return [
          {
            equipment_inspection_item_id: 31n,
            plant_id: 7n,
            inspection_type_code: "MAINTENANCE",
            is_active: true,
          },
        ];
      if (sql.includes("FROM mdm.equipment "))
        return options.useMold ? [] : [options.equipment ?? equipmentTarget()];
      if (sql.includes("FROM mdm.mold"))
        return options.useMold ? [options.mold ?? moldTarget()] : [];
      if (sql.includes("maintenance.breakdown"))
        return options.breakdownRows ?? [];
      if (sql.includes("maintenance.equipment_inspection"))
        return options.inspectionRows ?? [];
      return [];
    }),
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    rawSql,
    assignmentReader,
    userReader,
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}
