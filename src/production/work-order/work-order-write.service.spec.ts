import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WorkOrderCreate,
  WorkOrderWriteService,
  workOrderUpdateData,
} from './work-order-write.service';

const WORK_ORDER = 700;

interface Seed {
  statusCode?: string;
  releasedAt?: Date | null;
  versionNo?: number;
  orderQty?: number;
  plannedStartAt?: Date | null;
  plannedEndAt?: Date | null;
}

type Row = Record<string, unknown>;

function stub(seed: Seed = {}) {
  const created: Row[] = [];
  const updated: Row[] = [];
  const tx = {
    $queryRaw: () =>
      Promise.resolve([
        {
          status_code: seed.statusCode ?? 'PLANNED',
          released_at: seed.releasedAt ?? null,
          version_no: seed.versionNo ?? 1,
          order_qty: seed.orderQty ?? 100,
          planned_start_at: seed.plannedStartAt ?? null,
          planned_end_at: seed.plannedEndAt ?? null,
        },
      ]),
    work_order: {
      update: ({ data }: { data: Row }) => {
        updated.push(data);
        return Promise.resolve({ version_no: 2 });
      },
    },
  };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
    work_order: {
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({ work_order_id: BigInt(WORK_ORDER) });
      },
    },
  } as unknown as PrismaService;
  const next = jest.fn().mockResolvedValue('WO-20260906-0001');
  const numbering = { next } as unknown as NumberingService;

  return { service: new WorkOrderWriteService(prisma, numbering), created, updated, next };
}

const body = (over: Partial<WorkOrderCreate> = {}): WorkOrderCreate => ({
  productionPlanId: 11,
  routingOperationId: 22,
  itemId: 33,
  orderQty: 100,
  uomId: 44,
  ...over,
});

describe('W/O 발행·수정 (I-6 PR ④)', () => {
  it('발행 — 유형을 안 보내면 `NORMAL` 을 «명시적으로» 넣는다', async () => {
    const { service, created } = stub();

    await service.create(body(), 9);

    // ⛔ 물리 `@default("NORMAL")` 에 맡기지 않는다 — 정적 기본값은 `prisma generate` 의존이다.
    expect(created[0]).toMatchObject({
      work_order_type_code: 'NORMAL',
      // 전이표 밖의 상수 · 물리 기본값이 있는 `priority_no` 도 같은 이유로 명시한다.
      status_code: 'PLANNED',
      priority_no: 100,
      work_order_no: 'WO-20260906-0001',
      created_by: 9,
    });
    // ⚠ `dueDate` 를 담을 칸이 없다 — 아무 칸에도 몰래 싣지 않는다.
    expect(Object.keys(created[0])).not.toContain('due_date');
  });

  it('발행 — `productionPlanId` 가 비면 400 `REQUIRED` 다(문의 040)', async () => {
    for (const productionPlanId of [undefined, null]) {
      const { service, created, next } = stub();

      await expect(service.create(body({ productionPlanId }), 9)).rejects.toMatchObject({
        errors: [{ field: 'productionPlanId', code: ERROR_CODE.REQUIRED }],
      });
      // ⭐ 채번보다 «앞»이다 — 거부한 요청이 번호를 태우지 않는다.
      expect(next).not.toHaveBeenCalled();
      expect(created).toEqual([]);
    }
  });

  it('발행 — 수량이 0 이면 400 이고 채번을 안 태운다', async () => {
    const { service, created, next } = stub();

    const caught = await service.create(body({ orderQty: 0 }), 9).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toMatchObject([
      { field: 'orderQty', code: ERROR_CODE.INVALID },
    ]);
    // ⭐ CHECK 위반을 DB 에 물어보지 않는다 — 손검사가 채번보다 앞이다.
    expect(next).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('수정 — 종료가 시작보다 앞서면 400 이다(한 칸만 와도 잠긴 행의 짝과 대조한다)', async () => {
    const plannedStartAt = new Date('2026-09-10T00:00:00Z');
    const { service, updated } = stub({ plannedStartAt });

    // `plannedEndAt` 한 칸만 보낸다 — 잠긴 행의 `planned_start_at` 과 대조해야 잡힌다.
    const caught = await service
      .update(WORK_ORDER, 1, { plannedEndAt: '2026-09-01T00:00:00Z' }, 9)
      .catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toMatchObject([
      { field: 'plannedEndAt', code: ERROR_CODE.INVALID },
    ]);
    expect(updated).toEqual([]);
  });

  it('수정 — 배포 뒤에는 400 `STATE_LOCKED` 다', async () => {
    const { service, updated } = stub({ statusCode: 'RELEASED', releasedAt: new Date() });

    const caught = await service.update(WORK_ORDER, 1, { priorityNo: 3 }, 9).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ContractException);
    expect((caught as ContractException).errors).toMatchObject([
      { field: 'statusCode', code: ERROR_CODE.STATE_LOCKED },
    ]);
    expect(updated).toEqual([]);
  });

  it('409 — If-Match 불일치 봉투에 `code:VERSION_CONFLICT` 와 `conflictCause:user` 가 함께 실린다', async () => {
    const { service, updated } = stub({ versionNo: 4 });

    const caught = await service.update(WORK_ORDER, 1, { priorityNo: 3 }, 9).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ConflictException);
    // 계약 `ProductionConflictResponse` 는 `code` 가 required 다 — 원인(`conflictCause`)과
    // 업무 사유(`code`)는 직교하고 이 자리에서만 겹친다.
    expect((caught as ConflictException).conflict).toEqual({
      conflictCause: 'user',
      code: 'VERSION_CONFLICT',
      message: expect.any(String),
    });
    expect(updated).toEqual([]);
  });

  it('수정 — 명시적 null 은 해제, 생략은 유지다', () => {
    const data = workOrderUpdateData({
      plannedEquipmentId: null,
      plannedMoldId: 5,
      remarks: null,
      orderQty: 7,
    });

    expect(data).toEqual({
      planned_equipment_id: null,
      planned_mold_id: 5n,
      remarks: null,
      order_qty: 7,
    });
    // 생략한 칸은 «키 자체가 없다» — `undefined` 를 넘기면 Prisma 가 무시해 같아 보이지만,
    // 그 사실에 기대면 null 을 보낸 요청이 조용히 무시되는 날이 온다(`column.ts` 주석).
    expect(Object.keys(data)).not.toContain('planned_shift_id');
    expect(Object.keys(data)).not.toContain('priority_no');
  });
});
