import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { UserWorkerLinkService } from './user-worker-link.service';

type WorkerRow = { worker_id: bigint; worker_no: string; worker_name: string; is_active: boolean; app_user_id: bigint | null };

/** `mdm.worker` 를 흉내 내는 표 — 연결 칸(`app_user_id`)이 어떻게 바뀌는지를 본다. */
function harness(workers: WorkerRow[], userExists = true) {
  const rows = workers.map((row) => ({ ...row }));
  const matches = (row: WorkerRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const cell = row[key as keyof WorkerRow];
      if (value !== null && typeof value === 'object' && 'not' in value) return cell !== (value as { not: unknown }).not;
      return cell === value;
    });
  const worker = {
    findUnique: async ({ where }: { where: { worker_id: bigint } }) => rows.find((row) => row.worker_id === where.worker_id) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { app_user_id: bigint | null } }) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => {
        row.app_user_id = data.app_user_id;
      });
      return { count: hit.length };
    },
  };
  const prisma = {
    app_user: { findUnique: async () => (userExists ? { app_user_id: 1n } : null) },
    worker,
    $transaction: (work: (tx: { worker: typeof worker }) => Promise<unknown>) => work({ worker }),
  } as unknown as PrismaService;
  return { service: new UserWorkerLinkService(prisma), rows };
}

const W = (id: number, appUserId: bigint | null, isActive = true): WorkerRow => ({
  worker_id: BigInt(id),
  worker_no: `W${id}`,
  worker_name: `작업자${id}`,
  is_active: isActive,
  app_user_id: appUserId,
});

const fieldOf = async (run: Promise<unknown>) => {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof ContractException ? error.errors[0] : error;
};

describe('UserWorkerLinkService (omf-all-around#104)', () => {
  it('연결이 없으면 세 칸이 모두 null 이다', async () => {
    const { service } = harness([W(10, null)]);
    await expect(service.get(1)).resolves.toEqual({ workerId: null, workerNo: null, workerName: null });
  });

  it('연결하면 그 작업자가 돌아오고, 바꾸면 앞의 연결이 풀린다(한 계정 = 한 작업자)', async () => {
    const { service, rows } = harness([W(10, 1n), W(11, null)]);

    await expect(service.replace(1, 11, 9)).resolves.toEqual({ workerId: 11, workerNo: 'W11', workerName: '작업자11' });
    expect(rows.map((row) => row.app_user_id)).toEqual([null, 1n]);
  });

  it('null 이면 연결을 푼다', async () => {
    const { service, rows } = harness([W(10, 1n)]);

    await service.replace(1, null, 9);
    expect(rows[0].app_user_id).toBeNull();
  });

  it('다른 계정에 연결된 작업자는 400 이다(한 작업자 = 한 계정)', async () => {
    const { service, rows } = harness([W(10, 2n)]);

    expect(await fieldOf(service.replace(1, 10, 9))).toMatchObject({ field: 'workerId', code: 'INVALID' });
    expect(rows[0].app_user_id).toBe(2n);
  });

  it('비활성 작업자와 없는 작업자는 400 이다', async () => {
    const { service } = harness([W(10, null, false)]);

    expect(await fieldOf(service.replace(1, 10, 9))).toMatchObject({ field: 'workerId', code: 'INVALID' });
    expect(await fieldOf(service.replace(1, 99, 9))).toMatchObject({ field: 'workerId', code: 'INVALID' });
  });

  it('없는 사용자는 404 다', async () => {
    const { service } = harness([], false);
    await expect(service.get(1)).rejects.toMatchObject({ status: 404 });
  });
});
