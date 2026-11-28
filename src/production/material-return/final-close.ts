import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * W/O 최종 마감(피처 017) 판정 — 반납 귀속이 「귀속 없음」(NONE_FINALIZED)이 되는 유일한 근거(FR-011 · research R-2).
 *
 * ⭐ 017 의 최종 마감 표(`work_order_final_close`)가 아직 없다 ⇒ 지금은 늘 빈 집합이다. 017 이 들어오면 이 함수만 바꾼다.
 *    판정은 반납이 서버에 도착한 때 한다 — 오프라인 대기분이 그사이 최종 마감된 W/O 면 귀속 없음이다(Q15).
 * ⭐ 주입 가능한 서비스로 둔다 — e2e 가 대역으로 바꿔 최종 마감 W/O 를 만든다(Q10·Q15·US4-6).
 */
@Injectable()
export class FinalCloseProbe {
  async finalizedWorkOrders(_db: Pick<Prisma.TransactionClient, '$queryRaw'>, _workOrderIds: readonly bigint[]): Promise<Set<bigint>> {
    return new Set();
  }
}
