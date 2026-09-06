import { NotFoundException } from '@nestjs/common';

import { ApprovalRequestInput, ApprovalService } from '../../core/approval';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultApprovalService } from './production-result-approval.service';

const RESULT_ID = 7000;
const REQUEST_NO = 'AP-260906-0001';

function stub(options: { missing?: boolean } = {}) {
  const requested: ApprovalRequestInput[] = [];
  const approvalWheres: unknown[] = [];
  const order: string[] = [];

  const tx = {
    $queryRaw: () => {
      order.push('lock-result');
      return Promise.resolve([{ production_result_id: BigInt(RESULT_ID) }]);
    },
    approval_request: {
      findMany: ({ where }: { where: unknown }) => {
        approvalWheres.push(where);
        return Promise.resolve([]);
      },
    },
  };

  const prisma = {
    production_result: {
      findUnique: () =>
        Promise.resolve(options.missing === true ? null : { production_result_id: BigInt(RESULT_ID) }),
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const next = jest.fn(() => {
    order.push('numbering');
    return Promise.resolve(REQUEST_NO);
  });

  const approvals = {
    request: (_tx: unknown, input: ApprovalRequestInput) => {
      order.push('approval-request');
      requested.push(input);
      return Promise.resolve({ approvalRequestId: 501n });
    },
  } as unknown as ApprovalService;

  return {
    service: new ProductionResultApprovalService(prisma, { next } as unknown as NumberingService, approvals),
    requested,
    approvalWheres,
    order,
    next,
  };
}

describe('생산 실적 정정 상신 (I-7 PR ③)', () => {
  it('상신 — `businessUnitId` 를 `null` 로 넘긴다', async () => {
    const harness = stub();

    const result = await harness.service.requestApproval(RESULT_ID, '양품 150 EA 누락', 9);

    expect(result).toEqual({ approvalRequestId: 501 });
    // ⚠ 9 상신자 중 P/O 만 전표 값을 준다 — 실적에는 사업부 축이 없다(문의 022).
    expect(harness.requested[0]).toEqual({
      approvalRequestNo: REQUEST_NO,
      approvalTypeCode: 'PRODUCTION_RESULT_CORRECT',
      targetTypeCode: 'PRODUCTION_RESULT',
      targetId: BigInt(RESULT_ID),
      businessUnitId: null,
      requestedBy: 9n,
      reason: '양품 150 EA 누락',
    });
    // 동시 상신을 막는 것은 «대상 행 잠금»이다 — 코어 조회만으로는 같은 순간의 둘이 다 통과한다.
    expect(harness.order.indexOf('lock-result')).toBeLessThan(harness.order.indexOf('approval-request'));
  });

  it('상신 — B급 400 을 «내지 않는다»(판정 입력이 없다 — 문의 041)', async () => {
    const harness = stub();

    // 본문이 `reason` 한 칸이라 「어떤 정정을 하려는지」를 서버가 모른다 — 계약 400 갈래 셋 중
    // 「B급이라 승인이 필요 없다」는 도달 불가다. 등급을 재려고 원본 수량을 읽지도 않는다.
    await harness.service.requestApproval(RESULT_ID, '사유만 고친다', 9);

    expect(harness.approvalWheres).toEqual([]);
    expect(harness.requested).toHaveLength(1);
  });

  it('상신 — 채번이 존재 확인보다 뒤다(결번을 안 만든다)', async () => {
    const harness = stub({ missing: true });

    const caught = await harness.service.requestApproval(RESULT_ID, '없는 실적', 9).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(NotFoundException);
    // 없는 실적에 AP 번호를 태우면 결번만 남는다(I-5 R-12).
    expect(harness.next).not.toHaveBeenCalled();
  });
});
