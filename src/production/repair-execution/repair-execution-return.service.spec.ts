import { ConflictException, ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { RepairExecutionReturnService } from './repair-execution-return.service';

type Row = Record<string, unknown>;

const REPAIR = 1001;
const STARTED_AT = '2026-09-01T02:00:00.000Z';
const RETURNED_AT = '2026-09-01T06:00:00.000Z';
const WORKER_NO = 'W-투입자';

function stub(options: { returnedAt?: string } = {}) {
  const updates: Row[] = [];
  const tx = {
    $queryRaw: () =>
      Promise.resolve([
        {
          started_at: new Date(STARTED_AT),
          returned_at: options.returnedAt === undefined ? null : new Date(options.returnedAt),
        },
      ]),
    repair_execution: {
      update: ({ data }: { data: Row }) => {
        updates.push(data);
        return Promise.resolve({
          repair_execution_id: BigInt(REPAIR),
          defect_record_id: 900n,
          repair_process_id: null,
          started_at: new Date(STARTED_AT),
          returned_at: data.returned_at,
          repair_qty: 40.5,
          uom_id: 7n,
          repair_result_code: data.repair_result_code,
          reintroduced_lot_id: null,
          terminal_id: null,
          // 투입 때 적힌 사번 — 이 값이 갱신 뒤에도 그대로여야 한다.
          worker_no: WORKER_NO,
          created_at: new Date(STARTED_AT),
          created_by: null,
        });
      },
    },
  };
  const prisma = {
    worker: { count: () => Promise.resolve(1) },
    $transaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;

  return { service: new RepairExecutionReturnService(prisma), updates };
}

describe('RepairExecutionReturnService.close', () => {
  it('이미 반출된 건은 409 INVALID_STATE 다 — 선례(400 STATE_LOCKED)와 갈린다', async () => {
    const it0 = stub({ returnedAt: RETURNED_AT });
    const error = (await it0.service
      .close(REPAIR, { returnedAt: RETURNED_AT, repairResultCode: 'SUCCEEDED' }, '반출자')
      .catch((e: unknown) => e)) as ConflictException;

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.conflict).toMatchObject({ code: 'INVALID_STATE', conflictCause: 'user' });
    expect(it0.updates).toEqual([]);
  });

  it('returnedAt 이 startedAt 과 «같으면» 통과한다(CHECK 가 `>=` 라 경계를 포함한다)', async () => {
    const it0 = stub();
    const view = await it0.service.close(
      REPAIR,
      { returnedAt: STARTED_AT, repairResultCode: 'FAILED' },
      '반출자',
    );

    expect(view.returnedAt).toBe(STARTED_AT);
    expect(view.repairResultCode).toBe('FAILED');
    // 짝을 «함께» 쓴다 — CHECK `ck_repair_execution_return` 이 한쪽만 채우는 것을 막는다.
    expect(it0.updates[0]).toEqual({
      returned_at: new Date(STARTED_AT),
      repair_result_code: 'FAILED',
    });

    const earlier = (await it0.service
      .close(REPAIR, { returnedAt: '2026-09-01T01:59:59.000Z', repairResultCode: 'FAILED' }, '반출자')
      .catch((e: unknown) => e)) as ContractException;
    expect(earlier.getStatus()).toBe(400);
    expect(earlier.errors[0]).toMatchObject({ field: 'returnedAt', code: 'RANGE' });
  });

  it('⭐ 반출이 worker_no 를 덮지 않는다 — 그 칸은 「투입한 사람」이다', async () => {
    const it0 = stub();
    const view = await it0.service.close(
      REPAIR,
      { returnedAt: RETURNED_AT, repairResultCode: 'SUCCEEDED' },
      '다른반출자',
    );

    expect(it0.updates[0]).not.toHaveProperty('worker_no');
    expect(view.workerNo).toBe(WORKER_NO);
  });
});
