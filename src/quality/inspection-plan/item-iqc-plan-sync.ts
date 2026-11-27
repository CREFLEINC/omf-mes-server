import { Prisma } from '@prisma/client';

/** 품목 전용 기준이 «있는» 품목 — 확정 버전이 없어도 친다. */
const ownActiveIqcPlan = { inspection_type_code: 'IQC', is_active: true } as const;

/**
 * 품목 화면에서 「수입검사 대상」을 바꿨는데 그 품목 전용 IQC 기준이 없으면 새로 만든다(사용자 결정 2026-11-04).
 * 버전 없는 헤더라 확정 버전을 채우기 전까지 입하는 IQC 를 생략으로 남긴다(omf-all-around#366).
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
