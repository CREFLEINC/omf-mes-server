import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { PrecheckDecisionContext, PrecheckDecisionCreate, PrecheckDecisionService } from './precheck-decision.service';

const WORK_ORDER = 900;
const EQUIPMENT = 500;
const INSPECTION = 700;
const WORKER_NO = '100027';
const DECIDED_AT = '2026-09-07T01:00:00.000Z';

function body(overrides: Partial<PrecheckDecisionCreate> = {}): PrecheckDecisionCreate {
  return {
    workOrderId: WORK_ORDER,
    equipmentId: EQUIPMENT,
    decidedAt: DECIDED_AT,
    controlLevelCode: 'WARN',
    decisionCode: 'PASSED',
    ...overrides,
  };
}

function context(overrides: Partial<PrecheckDecisionContext> = {}): PrecheckDecisionContext {
  return { workerNo: WORKER_NO, appUserId: 9, ...overrides };
}

interface StubOptions {
  worker?: boolean;
  workOrder?: { work_order_type_code: string } | null;
  equipment?: boolean;
  inspection?: boolean;
  codeValues?: { code: string; groupCode: string }[];
}

function stub(options: StubOptions = {}) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    worker: {
      // `assertWorkerNoExists`(공용) 는 실재만 보므로 `count` 다 — 이 서비스는 `worker_id` 를
      // 안 쓴다(`precheck_decision.worker_no` 는 헤더 «문자열»을 그대로 옮겨 적는 칸이다).
      count: () => Promise.resolve(options.worker === false ? 0 : 1),
      findUnique: () =>
        Promise.resolve(options.worker === false ? null : { worker_id: 1n }),
    },
    work_order: {
      findUnique: () =>
        Promise.resolve(
          options.workOrder === undefined ? { work_order_type_code: 'NORMAL' } : options.workOrder,
        ),
    },
    equipment: {
      count: () => Promise.resolve(options.equipment === false ? 0 : 1),
    },
    equipment_inspection: {
      count: () => Promise.resolve(options.inspection === false ? 0 : 1),
    },
    code_value: {
      findMany: () =>
        Promise.resolve(
          (options.codeValues ?? [{ code: 'EMERGENCY_WORK_ORDER', groupCode: 'CONTROL_OVERRIDE_REASON' }]).map(
            (v) => ({ code: v.code, code_group: { group_code: v.groupCode } }),
          ),
        ),
    },
    precheck_decision: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({
          precheck_decision_id: 5001n,
          basis_inspection_id: null,
          override_reason_code: null,
          worker_no: null,
          ...data,
        });
      },
    },
  } as unknown as PrismaService;
  return { prisma, created };
}

describe('PrecheckDecisionService', () => {
  it('통제 판정을 201 로 기록한다 — worker_no 는 헤더 문자열을 그대로 저장한다', async () => {
    const { prisma, created } = stub();
    const service = new PrecheckDecisionService(prisma);

    const result = await service.create(body(), context());

    expect(result).toMatchObject({ precheckDecisionId: 5001, workOrderId: WORK_ORDER, decisionCode: 'PASSED' });
    expect(created[0]).toMatchObject({ worker_no: WORKER_NO, created_by: 9 });
  });

  it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
    const { prisma } = stub();
    const service = new PrecheckDecisionService(prisma);

    await expect(service.create(body(), context({ workerNo: undefined }))).rejects.toMatchObject({
      response: { errors: [{ field: 'X-Worker-No', code: ERROR_CODE.REQUIRED }] },
    });
  });

  it('없는 작업자 사번이면 400 INVALID', async () => {
    const { prisma } = stub({ worker: false });
    const service = new PrecheckDecisionService(prisma);

    await expect(service.create(body(), context())).rejects.toMatchObject({
      response: { errors: [{ field: 'X-Worker-No', code: ERROR_CODE.INVALID }] },
    });
  });

  it('없는 workOrderId 면 400 INVALID', async () => {
    const { prisma } = stub({ workOrder: null });
    const service = new PrecheckDecisionService(prisma);

    await expect(service.create(body(), context())).rejects.toMatchObject({
      response: { errors: [{ field: 'workOrderId', code: ERROR_CODE.INVALID }] },
    });
  });

  it('없는 equipmentId 면 400 INVALID', async () => {
    const { prisma } = stub({ equipment: false });
    const service = new PrecheckDecisionService(prisma);

    await expect(service.create(body(), context())).rejects.toMatchObject({
      response: { errors: [{ field: 'equipmentId', code: ERROR_CODE.INVALID }] },
    });
  });

  it('basisInspectionId 가 없는 점검이면 400 INVALID — 유형·주기·판정은 안 본다', async () => {
    const { prisma } = stub({ inspection: false });
    const service = new PrecheckDecisionService(prisma);

    await expect(service.create(body({ basisInspectionId: INSPECTION }), context())).rejects.toMatchObject({
      response: { errors: [{ field: 'basisInspectionId', code: ERROR_CODE.INVALID }] },
    });
  });

  it('basisInspectionId 가 있으면 그대로 저장한다', async () => {
    const { prisma, created } = stub();
    const service = new PrecheckDecisionService(prisma);

    await service.create(body({ basisInspectionId: INSPECTION }), context());

    expect(created[0]).toMatchObject({ basis_inspection_id: BigInt(INSPECTION) });
  });

  it('OVERRIDDEN 인데 사유가 없으면 400 REQUIRED', async () => {
    const { prisma } = stub({ workOrder: { work_order_type_code: 'EMERGENCY' } });
    const service = new PrecheckDecisionService(prisma);

    await expect(service.create(body({ decisionCode: 'OVERRIDDEN' }), context())).rejects.toMatchObject({
      response: { errors: [{ field: 'overrideReasonCode', code: ERROR_CODE.REQUIRED }] },
    });
  });

  it('OVERRIDDEN 인데 긴급 W/O 가 아니면 400 INVALID', async () => {
    const { prisma } = stub({ workOrder: { work_order_type_code: 'NORMAL' } });
    const service = new PrecheckDecisionService(prisma);

    await expect(
      service.create(body({ decisionCode: 'OVERRIDDEN', overrideReasonCode: 'EMERGENCY_WORK_ORDER' }), context()),
    ).rejects.toMatchObject({
      response: { errors: [{ field: 'overrideReasonCode', code: ERROR_CODE.INVALID }] },
    });
  });

  it('OVERRIDDEN 이 아닌데 사유가 오면 400 INVALID', async () => {
    const { prisma } = stub();
    const service = new PrecheckDecisionService(prisma);

    await expect(
      service.create(body({ decisionCode: 'PASSED', overrideReasonCode: 'OTHER' }), context()),
    ).rejects.toMatchObject({
      response: { errors: [{ field: 'overrideReasonCode', code: ERROR_CODE.INVALID }] },
    });
  });

  it('overrideReasonCode 가 CONTROL_OVERRIDE_REASON 밖이면 400 INVALID(assertCodeValues)', async () => {
    const { prisma } = stub({ workOrder: { work_order_type_code: 'EMERGENCY' }, codeValues: [] });
    const service = new PrecheckDecisionService(prisma);

    await expect(
      service.create(body({ decisionCode: 'OVERRIDDEN', overrideReasonCode: 'NOT_A_REAL_CODE' }), context()),
    ).rejects.toBeInstanceOf(ContractException);
  });

  it('긴급 W/O 의 OVERRIDDEN 은 201 로 기록된다', async () => {
    const { prisma, created } = stub({ workOrder: { work_order_type_code: 'EMERGENCY' } });
    const service = new PrecheckDecisionService(prisma);

    const result = await service.create(
      body({ decisionCode: 'OVERRIDDEN', overrideReasonCode: 'EMERGENCY_WORK_ORDER' }),
      context(),
    );

    expect(result.decisionCode).toBe('OVERRIDDEN');
    expect(created[0]).toMatchObject({ override_reason_code: 'EMERGENCY_WORK_ORDER' });
  });

  it('operation_policy 를 읽지 않는다 — 화면이 읽은 controlLevelCode 를 그대로 저장한다', async () => {
    const { prisma, created } = stub();
    // ⛔ 이 스텁에는 `operation_policy` 접근자가 아예 없다 — 부르면 TypeError 로 즉시 드러난다.
    const service = new PrecheckDecisionService(prisma);

    const result = await service.create(body({ controlLevelCode: 'BLOCK' }), context());

    expect(result.controlLevelCode).toBe('BLOCK');
    expect(created[0]).toMatchObject({ control_level_code: 'BLOCK' });
  });

  it('같은 판정을 두 번 기록해도 409 를 내지 않는다 — 유일성 검사가 없다', async () => {
    const { prisma } = stub();
    const service = new PrecheckDecisionService(prisma);

    const first = await service.create(body(), context());
    const second = await service.create(body(), context());

    expect(first.decisionCode).toBe('PASSED');
    expect(second.decisionCode).toBe('PASSED');
  });
});
