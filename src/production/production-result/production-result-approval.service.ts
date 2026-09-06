import { Injectable, NotFoundException } from '@nestjs/common';

import { ApprovalService } from '../../core/approval';
import { Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';

/** 승인 다형 축 — `production_result` 에 승인 FK 가 없다. 상신과 정정 게이트가 «같은 두 값»을 써야 만난다(`plan.md` §5 #12). */
export const CORRECT_APPROVAL_TYPE = 'PRODUCTION_RESULT_CORRECT';
export const CORRECT_APPROVAL_TARGET_TYPE = 'PRODUCTION_RESULT';
const APPROVAL_NUMBERING_DOCUMENT = 'APPROVAL_REQUEST';

/**
 * 실적 정정 승인 상신(I-7 PR ③ · §6). 승인 «요청»만 만든다.
 *
 * ⛔ 「B급이라 승인이 필요 없다」 400 을 **내지 않는다** — 본문이 `reason` 한 칸이라 무엇을
 *    정정하려는지 서버가 모른다(계약 400 갈래 셋 중 하나가 도달 불가 · 문의 041).
 * ⛔ 원본을 건드리지 않고 상신 본문을 뒤의 `:correct` 와 대조하지도 않는다 — `W-02-05` §5-8
 *    ⌜승인이 끝난 뒤 정정 값은 이 화면에서 다시 입력해 저장한다⌝.
 * ⛔ 코어가 던지는 `ROUTE_NOT_FOUND`·`APPROVAL_IN_PROGRESS` 를 다시 감싸지 않는다.
 */
@Injectable()
export class ProductionResultApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
  ) {}

  async requestApproval(
    productionResultId: number,
    reason: string,
    appUserId: number,
  ): Promise<{ approvalRequestId: number }> {
    // 존재 확인이 채번보다 «앞»이다 — 없는 실적에 AP 번호를 태우면 결번만 남는다(I-5 R-12).
    const exists = await this.prisma.production_result.findUnique({
      where: { production_result_id: BigInt(productionResultId) },
      select: { production_result_id: true },
    });
    if (exists === null) throw new NotFoundException('없는 생산 실적입니다.');

    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 · ⚠ 기간키가 UTC 라 하노이 00:00–07:00 의 상신은
    //    «전날» 번호를 받는다 — 둘 다 P/O `:288-297` 과 같은 자리고 같은 이유다.
    const approvalRequestNo = await this.numbering.next(
      APPROVAL_NUMBERING_DOCUMENT,
      null,
      new Date().toISOString().slice(0, 10),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      // 동시 상신을 막는 자물쇠 — 코어의 `assertNoOpenRequest` 는 조회일 뿐이라 같은 순간의
      // 둘이 다 통과한다(`approval.service.ts:98-100`).
      await lockResult(tx, productionResultId);
      return this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: CORRECT_APPROVAL_TYPE,
        targetTypeCode: CORRECT_APPROVAL_TARGET_TYPE,
        targetId: BigInt(productionResultId),
        // ⚠ 9 상신자 중 P/O 만 전표 값을 준다 — 실적에는 사업부 축이 없다(문의 022).
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason,
      });
    });
    return { approvalRequestId: Number(created.approvalRequestId) };
  }
}

/** 대상 행 잠금. 밖에서 존재를 이미 봤으므로 사라진 경우만 404 로 되돌린다. */
export async function lockResult(tx: Tx, productionResultId: number): Promise<void> {
  const rows = await tx.$queryRaw<{ production_result_id: bigint }[]>`
    SELECT production_result_id
      FROM production.production_result
     WHERE production_result_id = ${BigInt(productionResultId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 생산 실적입니다.');
}
