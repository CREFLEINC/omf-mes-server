import { PrismaService } from "../../prisma/prisma.service";
import { MaintenanceOrderQueryService } from "./order-query.service";

describe("MaintenanceOrderQueryService", () => {
  const findMany = jest.fn();
  const count = jest.fn();
  const findUnique = jest.fn();
  const tx = { maintenance_order: { findMany, count } };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new MaintenanceOrderQueryService({
    $transaction: transaction,
    maintenance_order: { findUnique },
  } as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(2);
  });

  it("모든 필터·정렬·페이지와 count가 같은 WHERE를 공유한다", async () => {
    const result = await service.list({
      targetTypeCode: "EQUIPMENT",
      targetId: 7,
      statusCode: "CUSTOM' --",
      maintenanceTypeCode: "CORRECTIVE",
      plannedFrom: "2026-09-01",
      plannedTo: "2026-09-30",
      page: 2,
      size: 1,
    });
    const options = findMany.mock.calls[0][0];
    expect(options.where).toEqual(count.mock.calls[0][0].where);
    expect(options.where).toEqual({
      target_type_code: "EQUIPMENT",
      equipment_id: 7,
      status_code: "CUSTOM' --",
      order_type_code: "CORRECTIVE",
      planned_date: {
        gte: new Date("2026-09-01T00:00:00Z"),
        lte: new Date("2026-09-30T00:00:00Z"),
      },
    });
    expect(options).toMatchObject({
      orderBy: [{ planned_date: "desc" }, { maintenance_order_id: "desc" }],
      skip: 1,
      take: 1,
    });
    expect(transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "RepeatableRead",
    });
    expect(result).toEqual({
      items: [],
      totalCount: 2,
      page: { page: 2, size: 1, total: 2 },
    });
  });

  it("targetType 없는 ID는 두 실제 FK를 OR로 조회한다", async () => {
    await service.list({ targetId: 7 });
    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ equipment_id: 7 }, { mold_id: 7 }],
    });
  });

  it.each([
    [{ plannedFrom: "2026-09-02", plannedTo: "2026-09-01" }, "plannedTo"],
    [{ page: Number.MAX_SAFE_INTEGER, size: 200 }, "page"],
    [{ targetId: Number.MAX_SAFE_INTEGER + 1 }, "targetId"],
  ])("역전·안전범위 초과는 DB 전에 400 RANGE다", async (query, name) => {
    await expect(service.list(query)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: name, code: "RANGE" }],
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("없는 상세은 404이고 안전범위 밖 path는 조회하지 않는다", async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.get(3)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.get(Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
