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
 * 기록에서 사라진다.
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
  const date = day('businessDate', effectiveDate);
  const plans = await tx.inspection_plan_version.findMany({
    where: {
      status_code: 'CONFIRMED',
      effective_from: { lte: date },
      OR: [{ effective_to: null }, { effective_to: { gte: date } }],
      inspection_plan: {
        item_id: itemId,
        inspection_type_code: inspectionTypeCode,
        is_active: true,
      },
    },
    select: { inspection_plan_version_id: true },
  });
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
  return plans[0].inspection_plan_version_id;
}
