import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkSessionWorkerService } from './work-session-worker.service';

type Row = Record<string, unknown>;
const JOINED = new Date('2026-09-07T02:00:00.000Z');

/** 세션 하나 — `open` 명이 이미 참여 중이고 `ended` 면 종료된 세션이다. 참여 행 7 은 `role` 이다. */
function stub(options: { open?: number; ended?: boolean; role?: string; active?: boolean } = {}) {
  const created: Row[] = [];
  const tx = {
    $queryRaw: () => Promise.resolve([{ status_code: options.ended ? 'ENDED' : 'RUNNING', version_no: 1 }]),
    work_session: { findUniqueOrThrow: () => Promise.resolve({ ended_at: options.ended ? new Date('2026-09-07T06:00:00.000Z') : null }) },
    work_session_worker: {
      // 앞의 count 는 「이 사람이 이미 참여 중인가」, 뒤의 count 는 「열린 참여자 수」다.
      count: ({ where }: { where: Row }) => Promise.resolve(where.worker_id === undefined ? (options.open ?? 1) : 0),
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({ ...data, work_session_worker_id: 9n, left_at: null, joined_at: JOINED, worker: { worker_no: 'W-8', worker_name: '작업자8' } });
      },
      findUnique: () =>
        Promise.resolve({ work_session_worker_id: 7n, work_session_id: 3n, worker_id: 1n, worker_role_code: options.role ?? 'SUB', joined_at: JOINED, left_at: null }),
      update: ({ data }: { data: Row }) =>
        Promise.resolve({ work_session_worker_id: 7n, worker_id: 1n, worker_role_code: options.role ?? 'SUB', joined_at: JOINED, ...data, worker: { worker_no: 'W-1', worker_name: '작업자1' } }),
    },
  };
  const prisma = {
    worker: { findUnique: () => Promise.resolve({ is_active: options.active ?? true }) },
    $transaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;
  return { service: new WorkSessionWorkerService(prisma), created };
}

const errorOf = (promise: Promise<unknown>) => promise.catch((e: unknown) => e) as Promise<ContractException>;
const join = (service: WorkSessionWorkerService, body: Row = {}) =>
  service.join(3, { workerId: 8, joinedAt: JOINED.toISOString(), ...body }, { version: undefined, appUserId: 5 });

describe('WorkSessionWorkerService — 공동 작업자 규칙', () => {
  it('열린 참여자가 이미 4명이면 400 이고 넣지 않는다', async () => {
    const it0 = stub({ open: 4 });
    const error = await errorOf(join(it0.service));
    expect(error.errors[0]).toMatchObject({ field: 'workerId', code: 'INVALID' });
    expect(it0.created).toEqual([]);
  });

  it('재직 중이 아닌 작업자는 참여하지 못한다', async () => {
    const it0 = stub({ active: false });
    const error = await errorOf(join(it0.service));
    expect(error.errors[0]).toMatchObject({ field: 'workerId', code: 'INVALID', message: '재직 중인 작업자가 아닙니다.' });
    expect(it0.created).toEqual([]);
  });

  it('작업 중 참여를 주작업자 역할로 보내면 400 이다', async () => {
    const error = await errorOf(join(stub().service, { workerRoleCode: 'MAIN' }));
    expect(error.errors[0]).toMatchObject({ field: 'workerRoleCode', code: 'INVALID' });
  });

  it('주작업자는 세션이 열린 동안 떠날 수 없다', async () => {
    const error = await errorOf(stub({ role: 'MAIN' }).service.leave(3, 7, { leftAt: '2026-09-07T03:00:00.000Z' }));
    expect(error.errors[0]).toMatchObject({ field: 'workSessionWorkerId', code: 'STATE_LOCKED' });
  });

  it('부작업자는 떠나고, 떠난 시각까지 참여 분을 센다', async () => {
    const view = await stub().service.leave(3, 7, { leftAt: '2026-09-07T03:00:00.000Z' });
    expect(view).toMatchObject({ leftAt: '2026-09-07T03:00:00.000Z', participatedMinutes: 60 });
  });
});
