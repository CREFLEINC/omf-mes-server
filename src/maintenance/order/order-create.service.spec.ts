import { ConflictException } from "../../common/errors";
import { NumberedMaintenanceWrite } from "../numbered-maintenance-write";
import { MaintenanceAssignmentPathChanged } from "./order-create-assignment";
import { MaintenanceOrderCreateService } from "./order-create.service";
import { MaintenanceOrderCreate } from "./order-create-input";

const context = {
  key: "idem-order",
  fingerprint: "fingerprint",
  appUserId: 7,
  successStatus: 201,
};

describe("maintenance order create service", () => {
  it("멱등 helper가 재생하면 입력 getter를 평가하지 않는다", async () => {
    const run = jest.fn(async (_input: unknown) => ({ replayed: true }));
    const service = new MaintenanceOrderCreateService({
      run,
    } as unknown as NumberedMaintenanceWrite);

    await expect(
      service.create({ targetId: -1 } as MaintenanceOrderCreate, context),
    ).resolves.toEqual({ replayed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("부여 경로 변경만 최초+3회 재시도하고 소진 시 409 user로 바꾼다", async () => {
    const run = jest.fn(async (_input: unknown) => ({}));
    const service = new MaintenanceOrderCreateService({
      run,
    } as unknown as NumberedMaintenanceWrite);
    await service.create(input(), context);
    const options = run.mock.calls[0][0] as {
      documentTypeCode: string;
      numberColumn: string;
      target: { type: string; id: number };
      periodDate: () => string;
      workRetry: {
        maxRetries: number;
        matches: (error: unknown) => boolean;
        exhausted: (error: unknown) => Error;
      };
    };

    expect(options.documentTypeCode).toBe("MAINTENANCE_ORDER");
    expect(options.numberColumn).toBe("maintenance_order_no");
    expect(options.target).toMatchObject({ type: "EQUIPMENT", id: 1 });
    expect(options.periodDate()).toBe("2026-09-10");
    expect(options.workRetry.maxRetries).toBe(3);
    expect(
      options.workRetry.matches(new MaintenanceAssignmentPathChanged()),
    ).toBe(true);
    expect(options.workRetry.matches(new Error("other"))).toBe(false);
    const exhausted = options.workRetry.exhausted(
      new MaintenanceAssignmentPathChanged(),
    );
    expect(exhausted).toBeInstanceOf(ConflictException);
    expect((exhausted as ConflictException).getStatus()).toBe(409);
    expect((exhausted as ConflictException).conflict.conflictCause).toBe(
      "user",
    );
  });
});

function input(): MaintenanceOrderCreate {
  return {
    targetTypeCode: "EQUIPMENT",
    targetId: 1,
    plannedDate: "2026-09-10",
    assigneeUserId: 2,
    items: [{ sequenceNo: 1, inspectionItemId: 3 }],
    triggers: [{ triggerTypeCode: "PM_DUE" }],
    baseDate: "2026-09-01",
  };
}
