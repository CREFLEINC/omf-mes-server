import { Prisma } from "@prisma/client";

import { IdempotencyService } from "../common/idempotency";
import { ConflictException, ContractException } from "../common/errors";
import { NumberingService } from "../core/numbering";
import { PrismaService } from "../prisma/prisma.service";
import { NumberedMaintenanceWrite } from "./numbered-maintenance-write";

const context = {
  key: "idem-1",
  fingerprint: "fingerprint",
  appUserId: 17,
  successStatus: 201,
};

describe("numbered maintenance write", () => {
  it("완료된 멱등키 재생은 설비 조회와 채번을 다시 하지 않는다", async () => {
    const setup = fake({ recordCount: 1, replayBody: "first" });

    await expect(setup.run()).resolves.toBe("first");
    expect(setup.prisma.equipment.findUnique).not.toHaveBeenCalled();
    expect(setup.numbering.next).not.toHaveBeenCalled();
    expect(setup.work).not.toHaveBeenCalled();
  });

  it("next 완료가 업무 tx와 콜백보다 앞선다", async () => {
    const events: string[] = [];
    const setup = fake({ events });

    await expect(setup.run()).resolves.toBe("created");
    expect(events).toEqual([
      "prepare-equipment",
      "number",
      "idempotency",
      "tx-equipment",
      "work",
    ]);
  });

  it("사전 확인 뒤 멱등행이 사라지면 callback 안 채번 없이 롤백하고 다시 준비한다", async () => {
    const setup = fake({ recordCount: 1 });

    await expect(setup.run()).resolves.toBe("created");
    expect(setup.idempotency.run).toHaveBeenCalledTimes(2);
    expect(setup.numbering.next).toHaveBeenCalledTimes(1);
    expect(setup.work).toHaveBeenCalledTimes(1);
  });

  it("번호 P2002만 tx 종료 뒤 다시 채번한다", async () => {
    const duplicate = prismaError("P2002", ["inspection_no"]);
    const setup = fake({ workErrors: [duplicate] });
    setup.numbering.next
      .mockResolvedValueOnce("EQI-1")
      .mockResolvedValueOnce("EQI-2");

    await expect(setup.run()).resolves.toBe("created");
    expect(setup.numbering.next).toHaveBeenCalledTimes(2);
    expect(setup.work).toHaveBeenNthCalledWith(1, expect.anything(), "EQI-1");
    expect(setup.work).toHaveBeenNthCalledWith(2, expect.anything(), "EQI-2");
  });

  it("다른 유일키 P2002는 재채번으로 삼키지 않는다", async () => {
    const duplicate = prismaError("P2002", [
      "equipment_inspection_id",
      "equipment_inspection_item_id",
    ]);
    const setup = fake({ workErrors: [duplicate] });

    await expect(setup.run()).rejects.toBe(duplicate);
    expect(setup.numbering.next).toHaveBeenCalledTimes(1);
  });

  it("번호 준비 뒤 공장이 바뀌면 업무를 쓰지 않고 409 user다", async () => {
    const setup = fake({ transactionPlantId: 8n });

    const error = await rejected(setup.run());
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).conflict.conflictCause).toBe("user");
    expect(setup.work).not.toHaveBeenCalled();
  });

  it("번호 충돌 네 번째에는 400 UNIQUE_VIOLATION이다", async () => {
    const duplicate = prismaError("P2002", ["inspection_no"]);
    const setup = fake({
      workErrors: [duplicate, duplicate, duplicate, duplicate],
    });

    const error = await rejected(setup.run());
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(400);
    expect((error as ContractException).errors).toEqual([
      expect.objectContaining({
        field: "inspectionNo",
        code: "UNIQUE_VIOLATION",
      }),
    ]);
    expect(setup.numbering.next).toHaveBeenCalledTimes(4);
  });
});

interface FakeOptions {
  events?: string[];
  recordCount?: number;
  replayBody?: string;
  transactionPlantId?: bigint;
  workErrors?: unknown[];
}

function fake(options: FakeOptions = {}) {
  const events = options.events ?? [];
  const prisma = {
    idempotency_record: {
      count: jest.fn(async () => options.recordCount ?? 0),
    },
    equipment: {
      findUnique: jest.fn(async () => {
        events.push("prepare-equipment");
        return { plant_id: 7n };
      }),
    },
  };
  const tx = {
    equipment: {
      findUnique: jest.fn(async () => {
        events.push("tx-equipment");
        return { plant_id: options.transactionPlantId ?? 7n };
      }),
    },
  };
  const numbering = {
    next: jest.fn(async () => {
      events.push("number");
      return "EQI-1";
    }),
  };
  let runCount = 0;
  const idempotency = {
    run: jest.fn(
      async (
        _context: unknown,
        callback: (client: typeof tx) => Promise<string>,
      ) => {
        events.push("idempotency");
        runCount += 1;
        if (options.replayBody !== undefined) {
          return { replayed: true, status: 201, body: options.replayBody };
        }
        return { replayed: false, status: 201, body: await callback(tx) };
      },
    ),
  };
  const errors = [...(options.workErrors ?? [])];
  const work = jest.fn(async () => {
    events.push("work");
    const error = errors.shift();
    if (error !== undefined) throw error;
    return "created";
  });
  const service = new NumberedMaintenanceWrite(
    prisma as unknown as PrismaService,
    idempotency as unknown as IdempotencyService,
    numbering as unknown as NumberingService,
  );
  return {
    prisma,
    idempotency,
    numbering,
    work,
    run: () =>
      service.run({
        context,
        documentTypeCode: "EQUIPMENT_INSPECTION",
        equipmentId: 1,
        periodDate: () => "2026-09-08",
        numberField: "inspectionNo",
        numberColumn: "inspection_no",
        work,
      }),
    runCount: () => runCount,
  };
}

function prismaError(code: string, target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("test", {
    code,
    clientVersion: "6.19.0",
    meta: { target },
  });
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}
