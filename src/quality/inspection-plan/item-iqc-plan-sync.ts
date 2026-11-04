import { Prisma } from '@prisma/client';

/** 품목 전용 기준이 «있는» 품목 — 확정 버전이 없어도 친다. 품목 화면이 만든 빈 기준도 그 품목의 설정을 고정한다. */
const ownActiveIqcPlan = { inspection_type_code: 'IQC', is_active: true } as const;

/**
 * 「전 품목 공통」 IQC 기준의 「기본 생략」을 전용 IQC 기준이 없는 품목의 「수입검사 대상」에 반대로 맞춘다.
 * 규칙: 품목 전용 기준이 있으면 그것을, 없으면 공통 기준을 따른다(사용자 결정 2026-11-04).
 * 이미 맞는 품목은 건드리지 않는다(품목 화면의 저장 토큰을 지킨다).
 */
export async function syncItemsToCommonIqcPlan(tx: Prisma.TransactionClient, defaultSkip: boolean): Promise<void> {
  await tx.item.updateMany({
    where: { inspection_required: defaultSkip, inspection_plan: { none: ownActiveIqcPlan } },
    data: { inspection_required: !defaultSkip, version_no: { increment: 1 } },
  });
}

/**
 * 품목 화면에서 「수입검사 대상」을 바꿨는데 그 품목 전용 IQC 기준이 없으면 새로 만든다 — 다음 공통 기준 저장이
 * 그 품목의 설정을 덮지 않게(사용자 결정 2026-11-04). 버전 없는 헤더라 입하는 종전처럼 공통 기준의 검사 항목을 쓴다.
 */
export async function ensureItemIqcPlan(
  tx: Prisma.TransactionClient,
  item: { item_id: bigint; item_code: string; item_name: string },
  defaultSkip: boolean,
): Promise<void> {
  const own = await tx.inspection_plan.count({ where: { item_id: item.item_id, ...ownActiveIqcPlan } });
  if (own > 0) return;
  await tx.inspection_plan.create({
    data: {
      inspection_plan_code: await freePlanCode(tx, item),
      inspection_plan_name: `${item.item_name} 수입검사`.slice(0, 200),
      inspection_type_code: 'IQC',
      item_id: item.item_id,
      default_skip: defaultSkip,
      pqc_skip_allowed: defaultSkip,
    },
  });
}

/** `IQC-품목코드`(50자 제한). 넘치거나 이미 쓰였으면 품목 id 로 만든다. */
async function freePlanCode(
  tx: Prisma.TransactionClient,
  item: { item_id: bigint; item_code: string },
): Promise<string> {
  const byCode = `IQC-${item.item_code}`;
  if (byCode.length <= 50) {
    const taken = await tx.inspection_plan.findUnique({ where: { inspection_plan_code: byCode }, select: { inspection_plan_id: true } });
    if (taken === null) return byCode;
  }
  return `IQC-ITEM-${item.item_id}`;
}
