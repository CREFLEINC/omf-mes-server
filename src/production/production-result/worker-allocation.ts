import { Prisma } from '@prisma/client';

import { WORKER_ROLE, WorkerShare, splitQuantities, workerShares } from '../work-session/crew';
import { QTY_COLUMNS } from './production-result-rules';

type Tx = Prisma.TransactionClient;
type Quantities = Record<(typeof QTY_COLUMNS)[keyof typeof QTY_COLUMNS], Prisma.Decimal>;
type ResultRow = Prisma.production_resultGetPayload<object>;

/** 계약 `ProductionResultWorkerAllocation`. */
export interface WorkerAllocationView {
  workerId: number;
  workerNo: string;
  workerName: string;
  workerRoleCode: string;
  participatedMinutes: number;
  shareRatio: number;
  goodQty: number;
  defectQty: number;
  holdQty: number;
  scrapQty: number;
  reworkQty: number;
}

/**
 * 실적 한 건을 그 구간에 참여한 작업자에게 나눠 저장한다. 구간은 같은 세션의 직전 실적(정정본 제외 · 이 실적보다 앞선 시각)부터
 * 이 실적까지, 첫 실적이면 세션 시작부터다. 같은 시각의 실적이 이미 있으면 그 실적과 같은 구간이라 그 비율을 쓴다 — 다시 재면
 * 구간이 `[t, t)` 로 비어 주작업자가 전부를 받는다. 세션이 없거나 참여자가 없으면 나누지 않는다 — 실적의 `workerId` 가 그대로 귀속이다.
 */
export async function allocateBySession(tx: Tx, row: ResultRow, appUserId: number | undefined): Promise<void> {
  if (row.work_session_id === null) return;
  const sameSession = { work_session_id: row.work_session_id, corrects_production_result_id: null, production_result_id: { not: row.production_result_id } };
  const sameTime = await tx.production_result.findFirst({
    where: { ...sameSession, occurred_at: row.occurred_at },
    orderBy: { production_result_id: 'asc' },
    select: { production_result_id: true },
  });
  if (sameTime !== null) return allocateLikeOriginal(tx, row, sameTime.production_result_id, appUserId);
  const [session, previous, participants] = await Promise.all([
    tx.work_session.findUniqueOrThrow({ where: { work_session_id: row.work_session_id }, select: { started_at: true } }),
    tx.production_result.findFirst({
      where: { ...sameSession, occurred_at: { lt: row.occurred_at } },
      orderBy: [{ occurred_at: 'desc' }, { production_result_id: 'desc' }],
      select: { occurred_at: true },
    }),
    tx.work_session_worker.findMany({
      where: { work_session_id: row.work_session_id },
      select: { worker_id: true, worker_role_code: true, joined_at: true, left_at: true },
    }),
  ]);
  if (participants.length === 0) return;
  const shares = workerShares(
    participants.map((p) => ({ workerId: p.worker_id, roleCode: p.worker_role_code, joinedAt: p.joined_at, leftAt: p.left_at })),
    previous?.occurred_at ?? session.started_at,
    row.occurred_at,
  );
  await writeAllocations(tx, row, shares, appUserId);
}

/** 정정 실적(과 같은 시각의 실적)은 다시 재지 않는다 — 그 실적의 비율·참여 분을 그대로 써서 수량을 나눈다. */
export async function allocateLikeOriginal(tx: Tx, row: ResultRow, originalId: bigint, appUserId: number | undefined): Promise<void> {
  const original = await tx.production_result_worker_allocation.findMany({
    where: { production_result_id: originalId },
    orderBy: { production_result_worker_allocation_id: 'asc' },
    select: { worker_id: true, worker_role_code: true, participated_minutes: true, share_ratio: true },
  });
  if (original.length === 0) return;
  // 끝전은 맨 앞이 받는다 — 원 배분과 같이 주작업자를 앞에 둔다.
  const shares = [...original]
    .sort((a, b) => Number(b.worker_role_code === WORKER_ROLE.MAIN) - Number(a.worker_role_code === WORKER_ROLE.MAIN))
    .map((item) => ({
      workerId: item.worker_id,
      roleCode: item.worker_role_code,
      participatedMinutes: item.participated_minutes.toNumber(),
      ratio: item.share_ratio,
    }));
  await writeAllocations(tx, row, shares, appUserId);
}

async function writeAllocations(tx: Tx, row: ResultRow, shares: readonly WorkerShare[], appUserId: number | undefined): Promise<void> {
  const quantities = Object.fromEntries(Object.values(QTY_COLUMNS).map((column) => [column, row[column]])) as Quantities;
  const parts = splitQuantities(quantities, shares);
  await tx.production_result_worker_allocation.createMany({
    data: shares.map((share, index) => ({
      production_result_id: row.production_result_id,
      worker_id: share.workerId,
      worker_role_code: share.roleCode,
      participated_minutes: share.participatedMinutes,
      share_ratio: share.ratio,
      ...parts[index],
      created_by: appUserId,
    })),
  });
}

/** 실적 여럿의 배분을 한 번에 읽는다 — 목록이 행마다 돌지 않게. 주작업자가 먼저다. */
export async function loadAllocations(
  prisma: Pick<Prisma.TransactionClient, 'production_result_worker_allocation'>,
  resultIds: readonly bigint[],
): Promise<Map<bigint, WorkerAllocationView[]>> {
  const map = new Map<bigint, WorkerAllocationView[]>();
  if (resultIds.length === 0) return map;
  const rows = await prisma.production_result_worker_allocation.findMany({
    where: { production_result_id: { in: [...resultIds] } },
    orderBy: { production_result_worker_allocation_id: 'asc' },
    include: { worker: { select: { worker_no: true, worker_name: true } } },
  });
  for (const row of rows) {
    const view: WorkerAllocationView = {
      workerId: Number(row.worker_id),
      workerNo: row.worker.worker_no,
      workerName: row.worker.worker_name,
      workerRoleCode: row.worker_role_code,
      participatedMinutes: row.participated_minutes.toNumber(),
      shareRatio: row.share_ratio.toNumber(),
      goodQty: row.good_qty.toNumber(),
      defectQty: row.defect_qty.toNumber(),
      holdQty: row.hold_qty.toNumber(),
      scrapQty: row.scrap_qty.toNumber(),
      reworkQty: row.rework_qty.toNumber(),
    };
    map.set(row.production_result_id, [...(map.get(row.production_result_id) ?? []), view]);
  }
  return map;
}
