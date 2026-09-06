import { CancelEligibility, CancelEligibilityService } from './cancel-eligibility.service';
import { DocumentProgressQueryService } from './document-progress-query.service';
import { DocumentProgressRow, documentProgressView } from './document-progress-view';
import { PrismaService } from '../../prisma/prisma.service';
import { LogisticsDocumentType } from './document-type-registry';

type Args = Record<string, unknown>;

/** `findMany`/`count` 만 답하는 최소 delegate 스텁 — 호출 여부·인자를 기록한다. */
function delegateStub(rows: Args[] = []) {
  const findManyCalls: Args[] = [];
  return {
    findMany: async (args: Args) => {
      findManyCalls.push(args);
      return rows;
    },
    count: async () => rows.length,
    findManyCalls,
  };
}

function fakePrisma(delegates: Record<string, ReturnType<typeof delegateStub>>): PrismaService {
  return delegates as unknown as PrismaService;
}

/** `evaluate()` 를 실제로 돌리지 않는다 — 이 스위트의 목은 질의·매핑이지 취소 판정이 아니다. */
function fakeEligibility(result: Partial<CancelEligibility> = {}): CancelEligibilityService {
  const full: CancelEligibility = { successorCount: 0, successors: [], cancellable: true, statusCode: '', ...result };
  return { evaluate: async () => full } as unknown as CancelEligibilityService;
}

const BASE_ELIGIBILITY: CancelEligibility = {
  successorCount: 0,
  successors: [],
  cancellable: true,
  statusCode: 'POSTED',
};

const BASE_ROW: DocumentProgressRow = {
  documentId: 1n,
  documentNo: 'X-1',
  documentDate: new Date('2026-08-01T00:00:00.000Z'),
  documentSubTypeCode: null,
  statusCode: 'POSTED',
  plannedQty: 10,
  processedQty: 10,
};

describe('DocumentProgressQueryService', () => {
  it('목록 — documentTypeCode 가 유형별 표 하나를 고른다(유니온을 짜지 않는다)', async () => {
    const goodsReceipt = delegateStub([]);
    const purchaseOrder = delegateStub([]);
    const service = new DocumentProgressQueryService(
      fakePrisma({ goods_receipt: goodsReceipt, purchase_order: purchaseOrder }),
      fakeEligibility(),
    );

    await service.list({ documentTypeCode: 'GOODS_RECEIPT' as LogisticsDocumentType });

    expect(goodsReceipt.findManyCalls).toHaveLength(1);
    expect(purchaseOrder.findManyCalls).toHaveLength(0);
  });

  it('목록 — 외주 2종은 q 와 warehouseId 를 함께 걸 수 있다', async () => {
    // noWhere·warehouseWhere 가 둘 다 `goods_issue` 관계 키를 낸다 — 스프레드로 합치면
    // 뒤가 앞을 덮어 q 가 사라진다(리뷰 #220 Major). AND 배열이면 둘 다 살아 있어야 한다.
    const subcontractIssue = delegateStub([]);
    const service = new DocumentProgressQueryService(
      fakePrisma({ subcontract_issue: subcontractIssue }),
      fakeEligibility(),
    );

    await service.list({
      documentTypeCode: 'SUBCONTRACT_ISSUE' as LogisticsDocumentType,
      q: 'GI-1',
      warehouseId: 5,
    });

    const where = subcontractIssue.findManyCalls[0].where as { AND: Args[] };
    expect(where.AND).toEqual([
      { goods_issue: { goods_issue_no: { contains: 'GI-1', mode: 'insensitive' } } },
      { goods_issue: { source_warehouse_id: 5 } },
    ]);
  });

  it('목록 — 라인 수량 칸이 하나뿐인 유형은 planned = processed 다', async () => {
    const row = {
      inbound_receipt_id: 1n,
      inbound_receipt_no: 'IR-1',
      receipt_datetime: new Date('2026-08-01T01:00:00.000Z'),
      status_code: 'POSTED',
      inbound_receipt_line: [{ received_qty: 30 }, { received_qty: 20 }],
    };
    const service = new DocumentProgressQueryService(
      fakePrisma({ inbound_receipt: delegateStub([row]) }),
      fakeEligibility(),
    );

    const result = await service.list({ documentTypeCode: 'INBOUND_RECEIPT' as LogisticsDocumentType });

    expect(result.items[0]).toMatchObject({ plannedQty: 50, processedQty: 50 });
  });

  it('목록 — 계획 칸이 없거나 NULL 이면 planned = processed 다', async () => {
    const row = {
      goods_receipt_id: 2n,
      goods_receipt_no: 'GR-1',
      receipt_datetime: new Date('2026-08-01T01:00:00.000Z'),
      status_code: 'POSTED',
      receipt_type_code: 'MATERIAL',
      // API 로 만든 입고는 expected_qty 가 언제나 NULL 이다(R-7 ⓐ).
      goods_receipt_line: [{ expected_qty: null, receipt_qty: 100 }],
    };
    const service = new DocumentProgressQueryService(
      fakePrisma({ goods_receipt: delegateStub([row]) }),
      fakeEligibility(),
    );

    const result = await service.list({ documentTypeCode: 'GOODS_RECEIPT' as LogisticsDocumentType });

    expect(result.items[0]).toMatchObject({ plannedQty: 100, processedQty: 100 });
  });

  it('목록 — remainingQty 는 음수를 0 으로 접지 않는다', async () => {
    const row = {
      purchase_order_id: 3n,
      purchase_order_no: 'PO-1',
      order_date: new Date('2026-08-01T00:00:00.000Z'),
      status_code: 'POSTED',
      purchase_order_line: [{ ordered_qty: 10, received_qty: 15 }],
    };
    const service = new DocumentProgressQueryService(
      fakePrisma({ purchase_order: delegateStub([row]) }),
      fakeEligibility(),
    );

    const result = await service.list({ documentTypeCode: 'PURCHASE_ORDER' as LogisticsDocumentType });

    expect(result.items[0]).toMatchObject({ plannedQty: 10, processedQty: 15, remainingQty: -5 });
  });

  it('목록 — 정렬은 업무 일자 desc + PK desc 다(계약 침묵 · 선례)', async () => {
    const goodsIssue = delegateStub([]);
    const pickingOrder = delegateStub([]);
    const service = new DocumentProgressQueryService(
      fakePrisma({ goods_issue: goodsIssue, picking_order: pickingOrder }),
      fakeEligibility(),
    );

    await service.list({ documentTypeCode: 'GOODS_ISSUE' as LogisticsDocumentType });
    await service.list({ documentTypeCode: 'PICKING_ORDER' as LogisticsDocumentType });

    expect(goodsIssue.findManyCalls[0].orderBy).toEqual([{ issued_at: 'desc' }, { goods_issue_id: 'desc' }]);
    // 일자 칸이 없는 둘(자재출고요청·피킹지시)은 created_at 으로 대신한다.
    expect(pickingOrder.findManyCalls[0].orderBy).toEqual([
      { created_at: 'desc' },
      { picking_order_id: 'desc' },
    ]);
  });

  it('매퍼 — screenId 는 언제나 키를 생략한다(널을 보내지 않는다)', () => {
    const view = documentProgressView('GOODS_ISSUE', BASE_ROW, BASE_ELIGIBILITY);

    expect(view).not.toHaveProperty('screenId');
  });

  it('목록 — 취소요청 중인 행은 cancelApprovalRequestId 를 낸다', () => {
    const view = documentProgressView('GOODS_RECEIPT', BASE_ROW, {
      ...BASE_ELIGIBILITY,
      cancellable: false,
      cancelBlockedReasonCode: 'CANCEL_IN_PROGRESS',
      cancelApprovalRequestId: 777n,
      statusCode: 'CANCEL_REQUESTED',
    });

    expect(view.cancelApprovalRequestId).toBe(777);
  });

  it('목록 — documentSubTypeCode 는 7종에서 키 생략이다', () => {
    const view = documentProgressView('PURCHASE_ORDER', BASE_ROW, BASE_ELIGIBILITY);

    expect(view).not.toHaveProperty('documentSubTypeCode');
  });
});
