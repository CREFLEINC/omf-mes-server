import { Prisma } from '@prisma/client';

import { ERROR_CODE, one } from '../../common/errors';
import { day } from '../../common/master';

/**
 * 품목·검사 유형으로 **그 날짜에 유효한 검사 기준 버전 하나**를 고른다.
 *
 * 입하(IQC)가 쓰던 것을 꺼내 출하(OQC)와 함께 쓴다 — 조회 조건은 한 글자도 바꾸지 않았고
 * 검사 유형만 인자가 됐다. 두 벌로 복제하면 「활성 버전이 무엇인가」의 답이 둘이 된다.
 *
 * ⛔ **0 건이든 2 건 이상이든 똑같이 400 으로 막는다.** 「하나를 골라 준다」가 아니라
 * 「하나로 정해져 있어야 한다」가 규칙이다 — `inspection_plan` 에 `(품목, 유형)` 유일 제약이
 * 없어 활성 기준이 둘 설 수 있고, 그때 서버가 임의로 고르면 어느 기준으로 검사했는지가
 * 기록에서 사라진다. 세는 단위는 기준이다 — 한 기준의 확정 버전은 최신 하나만 친다(`latestPerPlan`).
 *
 * ⚠ 물리는 `inspection_request.inspection_plan_version_id` 를 nullable 로 열어 두었지만
 * (마이그 `20260907174412`), 그 마이그레이션의 COMMENT 가 「IQC·OQC 의뢰는 서버가 언제나
 * 채워 내린다」라고 못박았다. 그래서 이 함수는 `bigint` 를 돌려주고 null 을 모른다.
 */
export async function resolveInspectionPlanVersion(
  tx: Prisma.TransactionClient,
  inspectionTypeCode: string,
  itemId: number,
  effectiveDate: string,
): Promise<bigint> {
  const plans = await candidatePlanVersions(tx, inspectionTypeCode, itemId, effectiveDate);
  if (plans.length !== 1) {
    throw one({
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message:
        plans.length === 0
          ? `유효한 ${inspectionTypeCode} 검사기준이 없습니다.`
          : `유효한 ${inspectionTypeCode} 검사기준이 여러 개입니다.`,
    });
  }
  return plans[0];
}

/**
 * 막지 않는 판 — 하나로 정해지면 그 버전, 아니면 `null`(omf-all-around#101 · 2026-10-16 결정 A).
 * 입하 IQC 는 기준이 없거나 둘 이상이어도 LOT·라벨 발행을 막지 않고 **기준 칸이 빈 의뢰**를 세운다 —
 * 임의로 하나를 고르지 않는다(위 「어느 기준으로 검사했는지」 규칙은 그대로다).
 */
export async function findInspectionPlanVersion(
  tx: Prisma.TransactionClient,
  inspectionTypeCode: string,
  itemId: number,
  effectiveDate: string,
): Promise<bigint | null> {
  const plans = await candidatePlanVersions(tx, inspectionTypeCode, itemId, effectiveDate);
  return plans.length === 1 ? plans[0] : null;
}

/**
 * 고른 기준 버전의 헤더가 「기본 생략」인가(omf-all-around#212 · 장부 P-152). 켜져 있으면 의뢰를 «검사할 일»로 세우지 않고
 * 생략(SKIPPED · 근거 DEFAULT) 기록만 남긴다 — 기록이 있어야 검사 목록이 그 건을 보이고 출하 관문이 통과로 읽는다.
 */
export async function planDefaultSkip(
  tx: Pick<Prisma.TransactionClient, 'inspection_plan_version'>,
  inspectionPlanVersionId: bigint,
): Promise<boolean> {
  const row = await tx.inspection_plan_version.findUnique({
    where: { inspection_plan_version_id: inspectionPlanVersionId },
    select: { inspection_plan: { select: { default_skip: true } } },
  });
  return row?.inspection_plan.default_skip === true;
}

/**
 * 품목 전용 IQC 기준(공통 기준 제외)이 그 날짜에 하나로 정해지고 「기본 생략」인가(omf-all-around#215).
 * 품목 「수입검사 대상」이 꺼져 있어도 이것이 참이면 입하가 생략 기록을 남긴다 — 두 설정은 저장 때 서로 맞춰진다.
 */
export async function itemIqcDefaultSkipped(
  tx: Pick<Prisma.TransactionClient, 'inspection_plan_version'>,
  itemId: number,
  effectiveDate: string,
): Promise<boolean> {
  const date = day('businessDate', effectiveDate);
  const versions = await tx.inspection_plan_version.findMany({
    where: {
      status_code: 'CONFIRMED',
      effective_from: { lte: date },
      OR: [{ effective_to: null }, { effective_to: { gte: date } }],
      inspection_plan: { item_id: itemId, inspection_type_code: 'IQC', is_active: true },
    },
    select: { inspection_plan_id: true, plan_version: true, inspection_plan: { select: { default_skip: true } } },
  });
  const latest = latestPerPlan(versions);
  return latest.length === 1 && latest[0].inspection_plan.default_skip;
}

/**
 * 한 기준에 그날 유효한 확정 버전이 여럿이면 최신(`plan_version` 이 가장 큰) 것만 남긴다(omf-all-around#208 · 사용자 결정 2026-10-30).
 * 엑셀 올리기는 새 버전을 바로 확정하고 앞 버전을 폐기하지 않는다 — 같은 기준의 옛 버전이 「여러 개」로 세지면 안 된다.
 * 서로 다른 기준끼리는 그대로 둔다(고르지 않는다).
 */
export function latestPerPlan<T extends { inspection_plan_id: bigint; plan_version: number }>(versions: T[]): T[] {
  const latest = new Map<bigint, T>();
  for (const version of versions) {
    const kept = latest.get(version.inspection_plan_id);
    if (kept === undefined || version.plan_version > kept.plan_version) latest.set(version.inspection_plan_id, version);
  }
  return [...latest.values()];
}

async function candidatePlanVersions(
  tx: Prisma.TransactionClient,
  inspectionTypeCode: string,
  itemId: number,
  effectiveDate: string,
): Promise<bigint[]> {
  const date = day('businessDate', effectiveDate);
  const find = (planItemId: number | null) =>
    tx.inspection_plan_version.findMany({
      where: {
        status_code: 'CONFIRMED',
        effective_from: { lte: date },
        OR: [{ effective_to: null }, { effective_to: { gte: date } }],
        inspection_plan: {
          item_id: planItemId,
          inspection_type_code: inspectionTypeCode,
          is_active: true,
        },
      },
      select: { inspection_plan_version_id: true, inspection_plan_id: true, plan_version: true },
    }).then(latestPerPlan);
  // 품목 전용 기준이 먼저다. 없을 때만 「전 품목 공통」(품목 칸이 빈 기준 · W-06-02)으로 내려간다
  // (omf-all-around#101) — 둘을 한 번에 세면 전용 기준이 있는 품목이 「여러 개」로 막힌다.
  // ⛔ 공통 기준으로 내려가는 것은 입하 IQC 뿐이다 — 출하 OQC 는 품목 전용 기준이 없으면 종전처럼 막는다(범위 밖).
  const own = await find(itemId);
  const plans = own.length > 0 || inspectionTypeCode !== 'IQC' ? own : await find(null);
  return plans.map((plan) => plan.inspection_plan_version_id);
}
