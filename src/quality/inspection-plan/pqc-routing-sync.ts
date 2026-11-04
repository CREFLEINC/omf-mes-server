import { Prisma } from '@prisma/client';

/** 연동 대상 PQC 기준 — 사용 중이고 공정이 지정됐다. */
type PqcPlanRow = Pick<
  Prisma.inspection_planGetPayload<object>,
  'inspection_type_code' | 'item_id' | 'process_id' | 'routing_id' | 'is_active' | 'default_skip'
>;

/** 라우팅 「검사 관리」와 맞추는 PQC 기준인가 — 공정이 빈 기준은 연동하지 않는다(사용자 결정 2026-11-04). */
export function isRoutingLinkedPqc(row: PqcPlanRow): row is PqcPlanRow & { process_id: bigint } {
  return row.inspection_type_code === 'PQC' && row.process_id !== null && row.is_active;
}

/**
 * PQC 기준의 「기본 생략」을 라우팅 공정의 「검사 관리」에 반대로 맞춘다(사용자 결정 2026-11-04 · IQC 품목 연동과 같은 결).
 * - 품목이 지정된 기준: 그 품목 라우팅(기준에 라우팅이 있으면 그 라우팅만)의 그 공정
 * - 품목이 빈 기준: 그 공정에 품목 전용 PQC 기준이 없는 품목의 라우팅 그 공정
 * ⭐ 확정 Rev 도 «검사 관리» 칸 하나만 바로 고친다 — W/O 배포가 확정 Rev 를 읽어, 작성 중 Rev 만 고치면 연동이 서지 않는다.
 * 이미 맞는 공정은 건드리지 않는다(라우팅 화면의 저장 토큰을 지킨다).
 */
export async function syncRoutingOperationsToPqcPlan(
  tx: Prisma.TransactionClient,
  plan: PqcPlanRow & { process_id: bigint },
): Promise<void> {
  const routing: Prisma.routingWhereInput =
    plan.item_id !== null
      ? { item_id: plan.item_id, ...(plan.routing_id === null ? {} : { routing_id: plan.routing_id }) }
      : { item: { inspection_plan: { none: { ...ownActivePqc, process_id: plan.process_id } } } };
  await tx.routing_operation.updateMany({
    where: { process_id: plan.process_id, inspection_managed: plan.default_skip, routing },
    data: { inspection_managed: !plan.default_skip, version_no: { increment: 1 } },
  });
}

const ownActivePqc = { inspection_type_code: 'PQC', is_active: true, item_id: { not: null } } as const;

/**
 * 라우팅 공정의 「검사 관리」를 바꾸면 그 품목 · 공정 PQC 기준의 「기본 생략」을 반대로 맞춘다. 기준이 없으면
 * 품목 + 공정 기준(버전 없는 헤더)을 만들어 설정을 고정한다 — 다음 공통 기준 저장이 덮지 않게(사용자 결정 2026-11-04).
 */
export async function syncPqcPlanToRoutingOperation(
  tx: Prisma.TransactionClient,
  target: { itemId: bigint; processId: bigint; inspectionManaged: boolean },
): Promise<void> {
  const skip = !target.inspectionManaged;
  const own = { item_id: target.itemId, process_id: target.processId, inspection_type_code: 'PQC', is_active: true };
  if ((await tx.inspection_plan.count({ where: own })) > 0) {
    await tx.inspection_plan.updateMany({
      where: { ...own, default_skip: !skip },
      data: { default_skip: skip, pqc_skip_allowed: skip, version_no: { increment: 1 } },
    });
    return;
  }
  const [item, process] = await Promise.all([
    tx.item.findUnique({ where: { item_id: target.itemId }, select: { item_code: true, item_name: true } }),
    tx.process.findUnique({ where: { process_id: target.processId }, select: { process_code: true, process_name: true } }),
  ]);
  if (item === null || process === null) return;
  await tx.inspection_plan.create({
    data: {
      inspection_plan_code: await freePlanCode(tx, `PQC-${item.item_code}-${process.process_code}`, target),
      inspection_plan_name: `${item.item_name} ${process.process_name} 공정검사`.slice(0, 200),
      inspection_type_code: 'PQC',
      item_id: target.itemId,
      process_id: target.processId,
      default_skip: skip,
      pqc_skip_allowed: skip,
    },
  });
}

/** 50자를 넘거나 이미 쓰였으면 품목 · 공정 id 로 만든다. */
async function freePlanCode(
  tx: Prisma.TransactionClient,
  byCode: string,
  target: { itemId: bigint; processId: bigint },
): Promise<string> {
  if (byCode.length <= 50) {
    const taken = await tx.inspection_plan.findUnique({ where: { inspection_plan_code: byCode }, select: { inspection_plan_id: true } });
    if (taken === null) return byCode;
  }
  return `PQC-ITEM-${target.itemId}-${target.processId}`;
}
