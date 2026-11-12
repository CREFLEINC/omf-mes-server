import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ConcessionCreate, ConcessionWriteService } from './concession-write.service';

/** omf-all-around#84 — 특채 요청·적용(장부 P-79) · 피처 005 — 특채는 남은 수량 전부(FR-038), LOT 이 여럿이면 LOT 마다 행·묶음 적용(D-14). */

const D = (value: number) => new Prisma.Decimal(value);

interface Options {
  approvalStatus?: string;
  concessionStatus?: string;
  decided?: number;
  affected?: number;
  ncStatus?: string;
  /** 묶음 행 — 기본은 LOT 10 하나에 30. */
  batch?: { lot_id: bigint; approved_qty: number }[];
  /** 요청 때 부적합 LOT — 기본은 LOT 10 하나(부적합 수량 30). */
  ncLots?: { lot_id: bigint; affected_qty: number }[];
}

const harness = (options: Options = {}) => {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const decisions: Record<string, unknown>[] = [];
  const batch = (options.batch ?? [{ lot_id: 10n, approved_qty: 30 }]).map((row, index) => ({
    concession_id: BigInt(7 + index), nonconformance_id: 41n, lot_id: row.lot_id, approved_qty: D(row.approved_qty), uom_id: 1n,
    approval_request_id: 99n, status_code: options.concessionStatus ?? 'PENDING', remarks: '외관 경미',
  }));
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('quality.concession') && sql.includes('concession_id =')) return [batch[0]];
      if (sql.includes('quality.concession')) return batch;
      return [{ status_code: options.ncStatus ?? 'PENDING_DECISION' }];
    }),
    nonconformance_lot: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { affected_qty: D(options.affected ?? 30) } }),
    },
    disposition_decision: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { decision_qty: D(options.decided ?? 0) }, _count: options.decided ? 1 : 0 }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        decisions.push(data);
        return { disposition_decision_id: 55n, decision_qty: data.decision_qty };
      }),
    },
    concession: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { concession_id: BigInt(6 + created.length) };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updates.push({ concession: data, where })),
    },
    nonconformance: { update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => updates.push({ nc: data })) },
    approval_request: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status_code: options.approvalStatus ?? 'APPROVED' }) },
  };
  const ncLots = (options.ncLots ?? [{ lot_id: 10n, affected_qty: 30 }]).map((row) => ({
    lot_id: row.lot_id, uom_id: 1n, affected_qty: D(row.affected_qty), lot: { lot_no: `L-${String(row.lot_id)}`, lot_type_code: 'MATERIAL', lifecycle_status_code: 'ACTIVE' },
  }));
  const prisma = {
    nonconformance: {
      findUnique: jest.fn().mockResolvedValue({ status_code: 'PENDING_DECISION', nonconformance_lot: ncLots }),
    },
    uom: { findUniqueOrThrow: jest.fn().mockResolvedValue({ decimal_scale: 0 }) },
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaService;
  let concessionSeq = 0;
  const numbering = {
    next: jest.fn(async (type: string) => {
      if (type !== 'CONCESSION') return 'AP-1';
      concessionSeq += 1;
      return `CNC-${String(concessionSeq)}`;
    }),
  } as unknown as NumberingService;
  const approvals = {
    request: jest.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      calls.push(`approval:${String(input.approvalTypeCode)}:${String(input.targetTypeCode)}`);
      return { approvalRequestId: 99n };
    }),
  } as unknown as ApprovalService;
  const documentState = { assertTransition: jest.fn().mockReturnValue({ to: 'DECIDED' }) } as unknown as DocumentStateService;
  const lots = {
    moveWithin: jest.fn(async (_tx: unknown, lotIds: bigint[], action: string) => {
      calls.push(`move:${action}:${lotIds.join(',')}`);
      return { movedLotIds: lotIds, skippedLotIds: [] };
    }),
  } as unknown as LotQualityStatusService;
  const holds = {
    lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 10n }, { lot_id: 11n }]),
    releaseWithin: jest.fn(async (_tx: unknown, _locked: unknown, _target: unknown, release: { releaseReasonCode: string }) => {
      calls.push(`release:${release.releaseReasonCode}`);
      return { openAfter: 0 };
    }),
  } as unknown as LotHoldService;
  const service = new ConcessionWriteService(prisma, numbering, approvals, documentState, lots, holds);
  return { service, calls, created, updates, decisions, numbering };
};

const body = (extra: Partial<ConcessionCreate> = {}): ConcessionCreate => ({
  nonconformanceId: 41, lotId: 10, approvedQty: 30, uomId: 1, validFrom: '2026-10-16', validTo: '2026-11-15',
  reason: '외관 경미 — 조건부 사용', ...extra,
});

describe('ConcessionWriteService.request', () => {
  it('특채(PENDING)와 결재(CONCESSION · 부적합 대상)를 함께 만든다', async () => {
    const h = harness();
    await expect(h.service.request(body(), 9)).resolves.toEqual({ concessionIds: [7], approvalRequestId: 99 });
    expect(h.calls).toEqual(['approval:CONCESSION:NONCONFORMANCE']);
    expect(h.created[0]).toMatchObject({
      concession_no: 'CNC-1', nonconformance_id: 41n, lot_id: 10n, status_code: 'PENDING',
      approval_request_id: 99n, remarks: '외관 경미 — 조건부 사용',
    });
  });

  it('US4-4 lotId 를 비우면 부적합 LOT 마다 특채 행(그 LOT 의 부적합 수량) — 결재는 1건', async () => {
    const h = harness({ affected: 30, ncLots: [{ lot_id: 10n, affected_qty: 10 }, { lot_id: 11n, affected_qty: 20 }] });
    await expect(h.service.request(body({ lotId: undefined }), 9)).resolves.toEqual({ concessionIds: [7, 8], approvalRequestId: 99 });
    expect(h.calls).toEqual(['approval:CONCESSION:NONCONFORMANCE']);
    expect(h.created.map((row) => [row.lot_id, row.approved_qty, row.approval_request_id, row.concession_no])).toEqual([
      [10n, D(10), 99n, 'CNC-1'], [11n, D(20), 99n, 'CNC-2'],
    ]);
  });

  it('부적합의 LOT 이 아니거나 남은 수량과 다르거나(R14a-1 일부 특채) 사유가 비면 400 이다', async () => {
    await expect(harness().service.request(body({ lotId: 11 }), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness({ affected: 100, decided: 80 }).service.request(body(), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness({ affected: 100 }).service.request(body(), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness().service.request(body({ reason: '  ' }), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness().service.request(body({ validTo: '2026-10-01' }), 9)).rejects.toBeInstanceOf(ContractException);
  });

  it('LOT 이 여럿인 부적합에 lotId 를 주면 400 이다', async () => {
    const h = harness({ affected: 30, ncLots: [{ lot_id: 10n, affected_qty: 10 }, { lot_id: 11n, affected_qty: 20 }] });
    await expect(h.service.request(body(), 9)).rejects.toBeInstanceOf(ContractException);
    expect(h.calls).toEqual([]);
  });
});

describe('ConcessionWriteService.apply', () => {
  it('승인이면 처분 판정(CONCESSION)·LOT 정상(C25)·보류 해제(CONCESSION_APPROVED)·특채 APPROVED', async () => {
    const h = harness();
    await expect(h.service.apply(7, 9)).resolves.toEqual({ concessionIds: [7], approvalRequestId: 99 });
    expect(h.decisions[0]).toMatchObject({ disposition_type_code: 'CONCESSION', decision_qty: D(30), approval_request_id: 99n });
    expect(h.calls).toEqual(['move:concession-apply:10', 'release:CONCESSION_APPROVED']);
    expect(h.updates).toEqual([
      { nc: expect.objectContaining({ status_code: 'DECIDED' }) },
      { concession: expect.objectContaining({ status_code: 'APPROVED' }), where: { concession_id: { in: [7n] } } },
    ]);
  });

  it('US4-4 묶음의 PENDING 행 전부를 한 번에 — 판정 1건(합계)·LOT 전부 정상·행 전부 APPROVED', async () => {
    const h = harness({ affected: 30, batch: [{ lot_id: 10n, approved_qty: 10 }, { lot_id: 11n, approved_qty: 20 }] });
    await h.service.apply(8, 9);
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]).toMatchObject({ decision_qty: D(30) });
    expect(h.calls).toEqual(['move:concession-apply:10', 'move:concession-apply:11', 'release:CONCESSION_APPROVED', 'release:CONCESSION_APPROVED']);
    expect(h.updates[1]).toEqual({ concession: expect.objectContaining({ status_code: 'APPROVED' }), where: { concession_id: { in: [7n, 8n] } } });
  });

  it('R14a-2 승인된 옛 일부 수량 특채(승인 < 남은 수량)는 409 이고 아무것도 바꾸지 않는다', async () => {
    const h = harness({ affected: 100 });
    const error = await h.service.apply(7, 9).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(409);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('일부 특채는 지원하지 않습니다');
    expect(h.decisions).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('업무 일자가 날짜가 아니면 400 이다', async () => {
    const h = harness();
    await expect(h.service.apply(7, 9, { businessDate: '11/03' })).rejects.toBeInstanceOf(ContractException);
  });

  it('결재 진행 중이면 400, 반려면 묶음을 REJECTED 로 닫고 LOT 은 그대로다', async () => {
    await expect(harness({ approvalStatus: 'PENDING' }).service.apply(7, 9)).rejects.toBeInstanceOf(ContractException);
    const rejected = harness({ approvalStatus: 'REJECTED' });
    await rejected.service.apply(7, 9);
    expect(rejected.updates).toEqual([{ concession: expect.objectContaining({ status_code: 'REJECTED' }), where: { concession_id: { in: [7n] } } }]);
    expect(rejected.calls).toEqual([]);
  });

  it('적용 시점에 남은 수량(부적합 수량 − 확정 판정 합)이 승인 수량보다 작으면 400 이고 아무것도 바꾸지 않는다', async () => {
    // (a) 요청 뒤 다른 처분이 100 중 80 을 먼저 썼다 — 남은 20 < 승인 30.
    const h = harness({ affected: 100, decided: 80 });
    const error = await h.service.apply(7, 9).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(400);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('approvedQty');
    expect(h.decisions).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it('남은 수량이 승인 수량과 같으면 적용해 부적합을 닫는다', async () => {
    const h = harness({ affected: 100, decided: 70 });
    await h.service.apply(7, 9);
    expect(h.decisions).toHaveLength(1);
    expect(h.numbering.next).not.toHaveBeenCalled();
    expect(h.updates[0]).toEqual({ nc: expect.objectContaining({ status_code: 'DECIDED' }) });
  });

  it('US4-4 이미 적용된 특채(묶음의 두 번째 적용)는 409 다', async () => {
    const error = await harness({ concessionStatus: 'APPROVED' }).service.apply(7, 9).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(409);
  });
});

it('없는 부적합은 404', async () => {
  const h = harness();
  (h.service as unknown as { prisma: { nonconformance: { findUnique: jest.Mock } } }).prisma.nonconformance.findUnique.mockResolvedValueOnce(null);
  await expect(h.service.request(body(), 9)).rejects.toBeInstanceOf(NotFoundException);
});
