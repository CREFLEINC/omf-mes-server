import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionApprovalService } from './disposition-approval.service';
import { approvalNonconformanceSummary } from './disposition-approval-view';
import { DispositionDecisionHook, DispositionWriteService } from './disposition-write.service';

/** omf-all-around#352 — 폐기·선별 처분 결재(결재선 없으면 바로 판정) · 반영 · 결재 진행 중 거절 · 결재함 부적합 요약. */

const D = (value: number) => new Prisma.Decimal(value);
const routeMissing = () => new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: 'ROUTE_NOT_FOUND', message: '없음' }]);

const approvalRow = (extra: Record<string, unknown> = {}) => ({
  disposition_approval_id: 5n, nonconformance_id: 41n, disposition_type_code: 'SCRAP', decision_qty: D(10), uom_id: 1n, lot_ids: [],
  good_qty: null, defect_qty: null, reason: '외관 불량', approval_request_id: 99n, status_code: 'PENDING', disposition_decision_id: null,
  created_at: new Date('2026-11-23T00:00:00Z'), uom: { uom_code: 'EA' }, approval_request: { status_code: 'PENDING' },
  created_by_user: { user_name: '요청자' }, ...extra,
});

interface Options {
  route?: 'found' | 'missing' | 'ambiguous';
  pendingApprovals?: number;
  pendingConcessions?: number;
  ncStatus?: string;
  affected?: number;
  decided?: number;
  updated?: number;
  stored?: Record<string, unknown> | null;
  approvalStatus?: string;
}

function harness(options: Options = {}) {
  const created: Record<string, unknown>[] = [];
  const closed: Record<string, unknown>[] = [];
  const marked: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('quality.disposition_approval')) return [{ status_code: 'PENDING' }];
      return [{ status_code: options.ncStatus ?? 'PENDING_DECISION', version_no: 3 }];
    }),
    disposition_approval: {
      count: jest.fn().mockResolvedValue(options.pendingApprovals ?? 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { disposition_approval_id: 5n };
      }),
      findMany: jest.fn().mockResolvedValue([approvalRow()]),
      updateMany: jest.fn(async (args: Record<string, unknown>) => {
        closed.push(args);
        return { count: 1 };
      }),
      update: jest.fn(async (args: Record<string, unknown>) => marked.push({ approval: args })),
    },
    disposition_decision: {
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(async (args: Record<string, unknown>) => marked.push({ decision: args })),
    },
    concession: { count: jest.fn().mockResolvedValue(options.pendingConcessions ?? 0) },
    nonconformance: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        source_nonconformance_id: null, inspection_request: { target_type_code: 'LOT' }, item: { base_uom_id: 1n },
        nonconformance_lot: [{ lot_id: 10n, affected_qty: D(options.affected ?? 30), uom_id: 1n }],
        disposition_decision: options.decided ? [{ decision_qty: D(options.decided) }] : [],
      }),
      updateMany: jest.fn().mockResolvedValue({ count: options.updated ?? 1 }),
    },
    nonconformance_lot: {
      findMany: jest.fn().mockResolvedValue([
        { lot_id: 10n, affected_qty: D(10), uom_id: 1n, quality_status_before_code: 'X', quality_status_after_code: 'Y' },
        { lot_id: 11n, affected_qty: D(20), uom_id: 1n, quality_status_before_code: 'X', quality_status_after_code: 'Y' },
      ]),
    },
    uom: { findUniqueOrThrow: jest.fn().mockResolvedValue({ decimal_scale: 0 }) },
    lot: { findMany: jest.fn().mockResolvedValue([{ lot_id: 10n, lot_no: 'ML-10' }]) },
  };
  const prisma = {
    ...tx,
    nonconformance: {
      ...tx.nonconformance,
      findUnique: jest.fn().mockResolvedValue({
        source_nonconformance_id: null,
        inspection_request: {
          inspection_request_id: 7n, inspection_type_code: 'IQC', target_type_code: 'INBOUND_LOT',
          inbound_lot: { inbound_lot_id: 8n, plant_id: 1n, plant: { timezone_code: 'Asia/Ho_Chi_Minh' } },
        },
      }),
    },
    disposition_approval: {
      ...tx.disposition_approval,
      findUnique: jest.fn().mockResolvedValue(options.stored === undefined
        ? { ...approvalRow(), approval_request: { status_code: options.approvalStatus ?? 'APPROVED' }, nonconformance: { version_no: 4 } }
        : options.stored),
    },
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaService;
  const approvals = {
    selectRoute: jest.fn(async () => {
      if (options.route === 'missing') throw routeMissing();
      if (options.route === 'ambiguous') {
        throw new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: 'ROUTE_AMBIGUOUS', message: '둘' }]);
      }
      return { approvalRouteId: 1n, steps: [] };
    }),
    request: jest.fn().mockResolvedValue({ approvalRequestId: 99n }),
  } as unknown as ApprovalService;
  const writes = {
    create: jest.fn(async (_nc: number, version: number, _body: unknown, _user: number, hook?: DispositionDecisionHook) => {
      if (hook !== undefined) await hook.afterDecision(tx as never, 55n);
      return { view: { dispositionDecisionId: 55 }, versionNo: version + 1 };
    }),
  } as unknown as DispositionWriteService;
  const numbering = { next: jest.fn().mockResolvedValue('AP-1') } as unknown as NumberingService;
  const service = new DispositionApprovalService(prisma, numbering, approvals, writes);
  return { service, tx, prisma, approvals, writes, created, closed, marked };
}

const scrap = { dispositionTypeCode: 'SCRAP', decisionQty: 10, uomId: 1, reason: '외관 불량' };
const sort = { dispositionTypeCode: 'SORT', lotIds: [10], goodQty: 5, defectQty: 5, reason: '선별' };
const conflictCode = (error: unknown): unknown => (error as ConflictException).conflict?.code;

describe('DispositionApprovalService.request', () => {
  it('결재선이 없으면(ROUTE_NOT_FOUND) 결재 없이 바로 판정한다 — 처분 판정 저장을 그대로 부른다', async () => {
    const h = harness({ route: 'missing' });
    await expect(h.service.request(41, 3, scrap, 9)).resolves.toEqual({
      result: { outcome: 'APPLIED', decision: { dispositionDecisionId: 55 } }, versionNo: 4,
    });
    expect(h.writes.create).toHaveBeenCalledWith(41, 3, scrap, 9);
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.created).toEqual([]);
  });

  it('결재선이 둘 이상(ROUTE_AMBIGUOUS)이면 그대로 400 — 바로 판정하지 않는다', async () => {
    const h = harness({ route: 'ambiguous' });
    await expect(h.service.request(41, 3, scrap, 9)).rejects.toBeInstanceOf(ContractException);
    expect(h.writes.create).not.toHaveBeenCalled();
  });

  it('결재선이 있으면 폐기는 DISPOSITION 결재(부적합 대상)와 PENDING 행을 만들고 부적합 판을 올린다', async () => {
    const h = harness();
    const done = await h.service.request(41, 3, scrap, 9);
    expect(done.result.outcome).toBe('REQUESTED');
    expect(done.result.dispositionApproval).toMatchObject({ dispositionApprovalId: 5, statusCode: 'PENDING', uomCode: 'EA', lotIds: [] });
    expect(done.versionNo).toBe(4);
    expect(h.approvals.request).toHaveBeenCalledWith(h.tx, expect.objectContaining({
      approvalTypeCode: 'DISPOSITION', targetTypeCode: 'NONCONFORMANCE', targetId: 41n, businessUnitId: null, reason: '외관 불량',
    }));
    expect(h.created[0]).toMatchObject({
      nonconformance_id: 41n, disposition_type_code: 'SCRAP', decision_qty: D(10), uom_id: 1n, approval_request_id: 99n, status_code: 'PENDING',
    });
    expect(h.tx.nonconformance.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { nonconformance_id: 41n, version_no: 3 } }));
    expect(h.writes.create).not.toHaveBeenCalled();
  });

  it('선별은 LOT 을 저장한다 — LOT 이 부적합 LOT 전부면 400', async () => {
    const h = harness();
    await h.service.request(41, 3, sort, 9);
    expect(h.created[0]).toMatchObject({ disposition_type_code: 'SORT', lot_ids: [10n], good_qty: 5, defect_qty: 5 });

    const all = harness();
    await expect(all.service.request(41, 3, { ...sort, lotIds: [10, 11] }, 9)).rejects.toBeInstanceOf(ContractException);
    expect(all.approvals.request).not.toHaveBeenCalled();
  });

  it.each([
    ['결재 진행 중인 처분 결재', { pendingApprovals: 1 }],
    ['결재 진행 중인 특채', { pendingConcessions: 1 }],
    ['닫힌 부적합', { ncStatus: 'DECIDED' }],
  ])('%s 가 있으면 409 INVALID_STATE — 결재를 올리지 않는다', async (_label, options) => {
    const h = harness(options);
    const error = await h.service.request(41, 3, scrap, 9).catch((caught: unknown) => caught);
    expect(conflictCode(error)).toBe('INVALID_STATE');
    expect(h.approvals.request).not.toHaveBeenCalled();
  });

  it('폐기 수량이 남은 수량을 넘으면 409 DISPOSITION_QTY_EXCEEDED · 판이 다르면 409 VERSION_CONFLICT', async () => {
    const over = harness({ decided: 25 });
    expect(conflictCode(await over.service.request(41, 3, scrap, 9).catch((caught: unknown) => caught))).toBe('DISPOSITION_QTY_EXCEEDED');
    const stale = harness({ updated: 0 });
    expect(conflictCode(await stale.service.request(41, 3, scrap, 9).catch((caught: unknown) => caught))).toBe('VERSION_CONFLICT');
  });
});

describe('DispositionApprovalService.apply', () => {
  it('결재가 진행 중이면 400 APPROVAL_IN_PROGRESS', async () => {
    const h = harness({ approvalStatus: 'PENDING' });
    const error = await h.service.apply(5, 4, 9).catch((caught: unknown) => caught);
    expect((error as ContractException).getStatus()).toBe(400);
    expect((error as ContractException).errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
    expect(h.writes.create).not.toHaveBeenCalled();
  });

  it('반려면 행을 REJECTED 로 닫고 돌려준다 — 판정을 만들지 않는다', async () => {
    const h = harness({ approvalStatus: 'REJECTED' });
    const done = await h.service.apply(5, 4, 9);
    expect(h.closed[0]).toMatchObject({ where: { disposition_approval_id: 5n, status_code: 'PENDING' }, data: { status_code: 'REJECTED' } });
    expect(done.result.decision).toBeUndefined();
    expect(done.versionNo).toBe(4);
    expect(h.writes.create).not.toHaveBeenCalled();
  });

  it('승인된 폐기는 저장한 수량으로 처분 판정을 만들고 같은 트랜잭션에서 판정·행을 반영 표시한다', async () => {
    const h = harness();
    const done = await h.service.apply(5, 4, 9);
    expect(h.writes.create).toHaveBeenCalledWith(41, 4, { dispositionTypeCode: 'SCRAP', reason: '외관 불량', decisionQty: 10, uomId: 1 }, 9, expect.any(Object));
    expect(h.marked).toEqual([
      { decision: { where: { disposition_decision_id: 55n }, data: { approval_request_id: 99n } } },
      { approval: expect.objectContaining({ data: expect.objectContaining({ status_code: 'APPLIED', disposition_decision_id: 55n }) }) },
    ]);
    expect(done.result.decision).toEqual({ dispositionDecisionId: 55 });
    expect(done.versionNo).toBe(5);
  });

  it('승인된 선별은 저장한 LOT·정보 수량으로 판정한다', async () => {
    const h = harness({
      stored: {
        ...approvalRow({ disposition_type_code: 'SORT', decision_qty: null, uom_id: null, lot_ids: [10n], good_qty: D(5), defect_qty: D(5) }),
        approval_request: { status_code: 'APPROVED' }, nonconformance: { version_no: 4 },
      },
    });
    await h.service.apply(5, 4, 9);
    expect(h.writes.create).toHaveBeenCalledWith(41, 4, { dispositionTypeCode: 'SORT', reason: '외관 불량', lotIds: [10], goodQty: 5, defectQty: 5 }, 9, expect.any(Object));
  });

  it('이미 반영·반려된 행은 409 INVALID_STATE · 없는 행은 404', async () => {
    const done = harness({ stored: { ...approvalRow({ status_code: 'APPLIED' }), approval_request: { status_code: 'APPROVED' }, nonconformance: { version_no: 4 } } });
    expect(conflictCode(await done.service.apply(5, 4, 9).catch((caught: unknown) => caught))).toBe('INVALID_STATE');
    const none = harness({ stored: null });
    await expect(none.service.apply(5, 4, 9)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DispositionWriteService — 결재 진행 중이면 바로 판정을 막고, 반영(hook)이면 통과한다', () => {
  const build = (pending: number) => {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ status_code: 'PENDING_DECISION', version_no: 3 }]),
      disposition_approval: { count: jest.fn().mockResolvedValue(pending) },
      nonconformance: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          source_nonconformance_id: null, inspection_request: null, item: { base_uom_id: 1n },
          nonconformance_lot: [{ lot_id: 10n, affected_qty: D(30), uom_id: 1n }], disposition_decision: [],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      uom: { findUniqueOrThrow: jest.fn().mockResolvedValue({ decimal_scale: 0 }) },
      disposition_decision: { create: jest.fn().mockResolvedValue({ disposition_decision_id: 55n }) },
      $queryRawUnsafe: jest.fn(async () => {
        order.push('view');
        return [{
          disposition_decision_id: 55, nonconformance_id: 41, disposition_type_code: 'SCRAP', decision_qty: '10', uom_id: 1, reason: '외관',
          decided_by: 9, decided_at: new Date(), approval_request_id: 99, nonconformance_no: 'NC-1', item_id: 1, item_code: 'I', item_name: '품목',
          decided_by_name: '판정자', lot_id: 10, lot_no: 'ML-10', posted_qty: '0',
        }];
      }),
    };
    const prisma = { $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)) } as unknown as PrismaService;
    const lots = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [10n], skippedLotIds: [] }) } as unknown as LotQualityStatusService;
    const documentState = { assertTransition: jest.fn().mockReturnValue({ to: 'DECIDED' }) } as unknown as DocumentStateService;
    const service = new DispositionWriteService(prisma, documentState, lots, {} as LotHoldService);
    return { service, tx, order };
  };
  const body = { dispositionTypeCode: 'SCRAP', decisionQty: 30, uomId: 1, reason: '외관' };

  it('결재 진행 중인 처분 결재가 있으면 409 INVALID_STATE — 판정을 만들지 않는다', async () => {
    const h = build(1);
    const error = await h.service.create(41, 3, body, 9).catch((caught: unknown) => caught);
    expect(conflictCode(error)).toBe('INVALID_STATE');
    expect(h.tx.disposition_decision.create).not.toHaveBeenCalled();
  });

  it('반영 hook 이면 거절을 건너뛰고 판정 뒤·응답 조회 전에 hook 을 부른다', async () => {
    const h = build(1);
    const afterDecision = jest.fn(async () => {
      h.order.push('hook');
    });
    const done = await h.service.create(41, 3, body, 9, { afterDecision });
    expect(afterDecision).toHaveBeenCalledWith(h.tx, 55n);
    expect(h.order).toEqual(['hook', 'view']);
    expect(h.tx.disposition_approval.count).not.toHaveBeenCalled();
    expect(done.view.approvalRequestId).toBe(99);
  });
});

describe('approvalNonconformanceSummary', () => {
  const build = (approval: Record<string, unknown> | null) => ({
    approval_request: { findUnique: jest.fn().mockResolvedValue(approval) },
    nonconformance: {
      findUnique: jest.fn().mockResolvedValue({
        nonconformance_id: 41n, nonconformance_no: 'NC-1', status_code: 'PENDING_DECISION', description: '찍힘', version_no: 4,
        item: { item_code: 'I-1', item_name: '품목', base_uom_id: 1n }, inspection_request: { inspection_type_code: 'IQC' },
        nonconformance_lot: [{ lot_id: 10n, affected_qty: D(30), uom_id: 1n, lot: { lot_no: 'ML-10' } }],
        disposition_decision: [{ decision_qty: D(10) }],
      }),
    },
    uom: { findUnique: jest.fn().mockResolvedValue({ uom_code: 'EA' }) },
    disposition_approval: { findMany: jest.fn().mockResolvedValue([approvalRow({ lot_ids: [10n] })]) },
    lot: { findMany: jest.fn().mockResolvedValue([{ lot_id: 10n, lot_no: 'ML-10' }]) },
    concession: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService);

  it('부적합 대상이 아닌 결재·없는 결재는 404', async () => {
    await expect(approvalNonconformanceSummary(build(null), 99)).rejects.toBeInstanceOf(NotFoundException);
    const other = build({ approval_request_id: 99n, approval_type_code: 'OQC_SKIP', target_type_code: 'SHIPMENT_REQUEST', target_id: 1n, reason: 'x' });
    await expect(approvalNonconformanceSummary(other, 99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('처분 결재면 부적합 요약·남은 수량·그 처분 결재 행을 내고 ETag 는 부적합 판 번호다', async () => {
    const prisma = build({ approval_request_id: 99n, approval_type_code: 'DISPOSITION', target_type_code: 'NONCONFORMANCE', target_id: 41n, reason: '외관' });
    const { summary, versionNo } = await approvalNonconformanceSummary(prisma, 99);
    expect(summary).toMatchObject({
      nonconformanceId: 41, nonconformanceNo: 'NC-1', itemCode: 'I-1', inspectionTypeCode: 'IQC', description: '찍힘', uomCode: 'EA',
      affectedQtyTotal: 30, remainingQty: 20, lots: [{ lotId: 10, lotNo: 'ML-10', affectedQty: 30 }], approvalTypeCode: 'DISPOSITION',
      dispositionApproval: { dispositionApprovalId: 5, lots: [{ lotId: 10, lotNo: 'ML-10' }] }, concession: null,
    });
    expect(versionNo).toBe(4);
  });
});
