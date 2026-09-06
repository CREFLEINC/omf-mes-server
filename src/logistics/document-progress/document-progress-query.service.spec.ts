import { NotFoundException } from '@nestjs/common';

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

/** 상세 GET(PR ③b) — DB 표 4개를 병렬로 본다. `Args`(위에서 이미 선언)는 delegate 호출 인자·행의 최소 모양. */
function docDelegateStub(row: Args | null) {
  return { findFirst: async () => row };
}

/** `approval_request`·`document_cancellation`·`inventory_transaction` 공통 스텁 — where 등호
 *  필터 + orderBy 한 칸으로 실제 DB 처럼 고른다(역행 배제·최신순 선택을 실제로 검증하려고). */
function tableStub(rows: Args[]) {
  return {
    findFirst: async (args: Args) => {
      const where = (args.where ?? {}) as Args;
      const matches = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (matches.length === 0) return null;
      const orderBy = args.orderBy as Record<string, 'asc' | 'desc'> | undefined;
      if (orderBy === undefined) return matches[0];
      const [key, dir] = Object.entries(orderBy)[0];
      const sorted = [...matches].sort((a, b) => {
        const diff = (a[key] as Date).getTime() - (b[key] as Date).getTime();
        return dir === 'desc' ? -diff : diff;
      });
      return sorted[0];
    },
  };
}

const DOC_ROW: Args = {
  goods_receipt_id: 1n,
  goods_receipt_no: 'GR-1',
  receipt_datetime: new Date('2026-01-01T00:00:00.000Z'),
  status_code: 'POSTED',
  receipt_type_code: 'MATERIAL',
  goods_receipt_line: [],
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  created_by: null,
};

function detailService(opts: {
  row?: Args | null;
  ledger?: Args[];
  approvals?: Args[];
  cancellations?: Args[];
  users?: Args[];
}): DocumentProgressQueryService {
  const prisma = {
    goods_receipt: docDelegateStub(opts.row === undefined ? DOC_ROW : opts.row),
    inventory_transaction: tableStub(opts.ledger ?? []),
    approval_request: tableStub(opts.approvals ?? []),
    document_cancellation: tableStub(opts.cancellations ?? []),
    app_user: { findMany: async () => opts.users ?? [] },
  } as unknown as PrismaService;
  return new DocumentProgressQueryService(prisma, fakeEligibility());
}

describe('DocumentProgressQueryService.detail — steps(I-5 PR ③b)', () => {
  it('상세 — 없는 id 면 404 다', async () => {
    const service = detailService({ row: null });

    await expect(service.detail('GOODS_RECEIPT' as LogisticsDocumentType, 1n)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('상세 — steps 는 원장이 없으면 POSTED 줄을 안 낸다', async () => {
    const service = detailService({ ledger: [] });

    const detail = await service.detail('GOODS_RECEIPT' as LogisticsDocumentType, 1n);

    expect(detail.steps.map((s) => s.stepCode)).toEqual(['REGISTERED']);
  });

  it('상세 — POSTED 줄은 actorName 을 생략하고 원장 번호·영업일을 싣는다', async () => {
    const ledger: Args = {
      inventory_transaction_id: 10n,
      business_date: new Date('2026-02-01T00:00:00.000Z'),
      transaction_no: 'TX-2026-0011',
      occurred_at: new Date('2026-02-01T01:00:00.000Z'),
      source_document_type_code: 'GOODS_RECEIPT',
      source_document_id: 1n,
      reversal_of_transaction_id: null,
    };
    const service = detailService({ ledger: [ledger] });

    const detail = await service.detail('GOODS_RECEIPT' as LogisticsDocumentType, 1n);

    const posted = detail.steps.find((s) => s.stepCode === 'POSTED');
    expect(posted).not.toHaveProperty('actorName');
    expect(posted).toMatchObject({ inventoryTransactionNo: 'TX-2026-0011', businessDate: '2026-02-01' });
  });

  it('상세 — 역처리 원장은 POSTED 줄의 원천이 아니다(reversal_of_transaction_id 가 있는 행은 건너뛴다)', async () => {
    const original: Args = {
      inventory_transaction_id: 10n,
      business_date: new Date('2026-02-01T00:00:00.000Z'),
      transaction_no: 'TX-ORIGINAL',
      occurred_at: new Date('2026-02-01T01:00:00.000Z'),
      source_document_type_code: 'GOODS_RECEIPT',
      source_document_id: 1n,
      reversal_of_transaction_id: null,
    };
    const reversal: Args = {
      inventory_transaction_id: 11n,
      business_date: new Date('2026-02-02T00:00:00.000Z'),
      transaction_no: 'TX-ORIGINAL-R',
      occurred_at: new Date('2026-02-02T01:00:00.000Z'),
      source_document_type_code: 'GOODS_RECEIPT',
      source_document_id: 1n,
      reversal_of_transaction_id: 10n,
    };
    const service = detailService({ ledger: [original, reversal] });

    const detail = await service.detail('GOODS_RECEIPT' as LogisticsDocumentType, 1n);

    const posted = detail.steps.find((s) => s.stepCode === 'POSTED');
    expect(posted?.inventoryTransactionNo).toBe('TX-ORIGINAL');
  });

  it('상세 — steps 는 occurredAt 오름차순이다', async () => {
    // 일부러 도메인상 있을 법하지 않은 순서로 채운다 — push 순서(등록·전기·취소요청)가 아니라
    // occurredAt 값으로 «다시» 정렬하는지를 검증한다.
    const ledger: Args = {
      inventory_transaction_id: 10n,
      business_date: new Date('2026-03-03T00:00:00.000Z'),
      transaction_no: 'TX-LATE',
      occurred_at: new Date('2026-03-03T00:00:00.000Z'),
      source_document_type_code: 'GOODS_RECEIPT',
      source_document_id: 1n,
      reversal_of_transaction_id: null,
    };
    const approval: Args = {
      target_type_code: 'GOODS_RECEIPT',
      target_id: 1n,
      approval_type_code: 'GOODS_RECEIPT_CANCEL',
      requested_at: new Date('2026-02-02T00:00:00.000Z'),
      requested_by: 7n,
    };
    const service = detailService({ ledger: [ledger], approvals: [approval], users: [] });

    const detail = await service.detail('GOODS_RECEIPT' as LogisticsDocumentType, 1n);

    expect(detail.steps.map((s) => s.stepCode)).toEqual(['REGISTERED', 'CANCEL_REQUESTED', 'POSTED']);
  });
});
