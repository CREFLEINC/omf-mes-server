import { Prisma } from '@prisma/client';

import { itemIqcDefaultSkipped } from '../../core/quality/inspection-plan-version';

type Db = Pick<Prisma.TransactionClient, 'item' | 'inspection_plan_version'>;

/**
 * 검사 불필요로 받은 입하 LOT 을 마감하면 IQC 가 「검사 생략」(SKIPPED · DEFAULT)으로 남는가 — 품목이 검사 대상(기준이 기본 생략)
 * 이거나 품목 전용 기준이 기본 생략일 때만(#101·#212·#215). 아니면 요청이 생기지 않는다(US2-7). 마감(`iqcRecordOf`)과
 * 마감 전 확인 창 문구(`iqcDefaultSkipApplies`)가 같은 판단을 쓴다.
 */
export async function iqcSkipRecorded(db: Db, itemId: bigint, effectiveDate: string): Promise<boolean> {
  const item = await db.item.findUniqueOrThrow({ where: { item_id: itemId }, select: { inspection_required: true } });
  return item.inspection_required || (await itemIqcDefaultSkipped(db, Number(itemId), effectiveDate));
}
