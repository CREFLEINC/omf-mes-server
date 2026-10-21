import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * 라인(설비 그룹) 노드 «자신»의 담당 부서. ⛔ 상위 라인(`parent_line_id`)으로 올라가지 않는다(research R-7).
 * 라인이 없거나, 부서가 없거나, 부서가 사용 중지면 `null` — 생성기가 `DEPARTMENT_UNRESOLVED` 로 남긴다.
 */
export async function resolveByLine(tx: Tx, lineId: bigint | null): Promise<bigint | null> {
  if (lineId === null) return null;
  const line = await tx.production_line.findUnique({
    where: { production_line_id: lineId },
    select: { department: { select: { department_id: true, is_active: true } } },
  });
  return activeDepartment(line?.department ?? null);
}

/** 결재 — 그 차례 결재자 본인의 부서. */
export async function resolveByUser(tx: Tx, appUserId: bigint): Promise<bigint | null> {
  const user = await tx.app_user.findUnique({
    where: { app_user_id: appUserId },
    select: { department: { select: { department_id: true, is_active: true } } },
  });
  return activeDepartment(user?.department ?? null);
}

function activeDepartment(department: { department_id: bigint; is_active: boolean } | null): bigint | null {
  return department?.is_active ? department.department_id : null;
}
