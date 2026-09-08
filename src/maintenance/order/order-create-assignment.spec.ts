import { Prisma } from "@prisma/client";

import { ContractException } from "../../common/errors";
import {
  MaintenanceAssignmentPathChanged,
  assertMaintenanceOrderAssignments,
} from "./order-create-assignment";

const target = {
  equipment_id: 1n,
  plant_id: 7n,
  production_line_id: 10n,
};
const direct = (isActive = true) => ({
  equipment_inspection_item_assignment_id: 101n,
  equipment_inspection_item_id: 31n,
  is_active: isActive,
});
const grouped = (id: bigint, isActive = true) => ({
  equipment_group_inspection_item_id: id,
  equipment_inspection_item_id: 31n,
  is_active: isActive,
});
const master = (override = {}) => ({
  equipment_inspection_item_id: 31n,
  plant_id: 7n,
  inspection_type_code: "MAINTENANCE",
  is_active: true,
  ...override,
});

describe("maintenance order effective assignments", () => {
  it("직접 부여와 항목 master를 잠근 뒤 현재 보전 항목을 승인한다", async () => {
    const setup = fake({
      direct: [[direct()], [direct()]],
      masters: [master()],
    });

    await expect(
      assertMaintenanceOrderAssignments(setup.tx, target, [
        { inspectionItemId: 31n },
      ]),
    ).resolves.toBeUndefined();
    expect(setup.group).not.toHaveBeenCalled();
    expect(setup.rawSql).toEqual([
      expect.stringContaining("equipment_inspection_item"),
    ]);
    expect(setup.rawSql[0]).toContain("FOR SHARE");
  });

  it("비활성 직접 부여도 상위층 fallback을 막고 요청 항목은 거부한다", async () => {
    const setup = fake({
      direct: [[direct(false)], [direct(false)]],
      masters: [master()],
    });

    const error = await rejected(
      assertMaintenanceOrderAssignments(setup.tx, target, [
        { inspectionItemId: 31n },
      ]),
    );
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors[0]).toMatchObject({
      field: "items[0].inspectionItemId",
      code: "INVALID",
    });
    expect(setup.group).not.toHaveBeenCalled();
  });

  it("빈 중간층을 포함한 가장 가까운 부여층 경로를 ID 순으로 잠근다", async () => {
    const setup = fake({
      direct: [[], []],
      groups: [[], [grouped(202n)], [], [grouped(202n)]],
      parents: [20n, 20n],
      lockedPath: [{ production_line_id: 10n }, { production_line_id: 20n }],
      masters: [master()],
    });

    await assertMaintenanceOrderAssignments(setup.tx, target, [
      { inspectionItemId: 31n },
    ]);
    expect(setup.rawSql[0]).toContain("production_line");
    expect(setup.rawSql[0]).toContain("ORDER BY production_line_id FOR SHARE");
    expect(setup.rawValues[0]).toEqual([10n, 20n]);
  });

  it("잠금 뒤 선택 층·경로·항목이 바뀌면 전체 tx 재시도 신호를 낸다", async () => {
    const setup = fake({
      direct: [[], []],
      groups: [[], [grouped(202n)], [grouped(303n)]],
      parents: [20n],
      lockedPath: [{ production_line_id: 10n }, { production_line_id: 20n }],
    });

    await expect(
      assertMaintenanceOrderAssignments(setup.tx, target, [
        { inspectionItemId: 31n },
      ]),
    ).rejects.toBeInstanceOf(MaintenanceAssignmentPathChanged);
    expect(setup.rawSql).toHaveLength(1);
  });

  it("후보 경로 행이 사라져도 무정렬 추가 잠금 없이 재시도 신호를 낸다", async () => {
    const setup = fake({
      direct: [[]],
      groups: [[], [grouped(202n)]],
      parents: [20n],
      lockedPath: [{ production_line_id: 10n }],
    });

    await expect(
      assertMaintenanceOrderAssignments(setup.tx, target, [
        { inspectionItemId: 31n },
      ]),
    ).rejects.toBeInstanceOf(MaintenanceAssignmentPathChanged);
    expect(setup.direct).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["다른 공장", { plant_id: 8n }],
    ["비보전 유형", { inspection_type_code: "DAILY" }],
    ["비활성 master", { is_active: false }],
  ])("%s 항목을 최종 master 잠금 뒤 거부한다", async (_name, override) => {
    const setup = fake({
      direct: [[direct()], [direct()]],
      masters: [master(override)],
    });

    await expect(
      assertMaintenanceOrderAssignments(setup.tx, target, [
        { inspectionItemId: 31n },
      ]),
    ).rejects.toBeInstanceOf(ContractException);
  });

  it("유효 부여에 없는 요청 항목은 master 조회 결과와 무관하게 거부한다", async () => {
    const setup = fake({
      direct: [[direct()], [direct()]],
      masters: [master()],
    });

    await expect(
      assertMaintenanceOrderAssignments(setup.tx, target, [
        { inspectionItemId: 99n },
      ]),
    ).rejects.toBeInstanceOf(ContractException);
  });
});

interface FakeOptions {
  direct?: ReturnType<typeof direct>[][];
  groups?: ReturnType<typeof grouped>[][];
  parents?: (bigint | null)[];
  lockedPath?: { production_line_id: bigint }[];
  masters?: ReturnType<typeof master>[];
}

function fake(options: FakeOptions) {
  const directRows = [...(options.direct ?? [])];
  const groupRows = [...(options.groups ?? [])];
  const parents = [...(options.parents ?? [])];
  const rawSql: string[] = [];
  const rawValues: unknown[][] = [];
  const directReader = jest.fn(async () => directRows.shift() ?? []);
  const group = jest.fn(async () => groupRows.shift() ?? []);
  const tx = {
    equipment_inspection_item_assignment: { findMany: directReader },
    equipment_group_inspection_item: { findMany: group },
    production_line: {
      findUnique: jest.fn(async () => ({
        parent_line_id: parents.shift() ?? null,
      })),
    },
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      const sql = query.strings.join("?");
      rawSql.push(sql);
      rawValues.push(query.values);
      return sql.includes("mdm.production_line")
        ? (options.lockedPath ?? [])
        : (options.masters ?? []);
    }),
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    direct: directReader,
    group,
    rawSql,
    rawValues,
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
