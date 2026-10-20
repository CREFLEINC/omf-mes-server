import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ConcessionCreate, ConcessionWriteService } from './concession-write.service';

/** omf-all-around#84 — 특채 요청·적용(장부 P-79). */

const D = (value: number) => new Prisma.Decimal(value);

interface Options {
  approvalStatus?: string;
  concessionStatus?: string;
  decided?: number;
  affected?: number;
  ncStatus?: string;
}

const harness = (options: Options = {}) => {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const decisions: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('quality.concession')) {
        return [{
          concession_id: 7n, nonconformance_id: 41n, lot_id: 10n, approved_qty: D(30), uom_id: 1n,
          approval_request_id: 99n, status_code: options.concessionStatus ?? 'PENDING', remarks: '외관 경미',
        }];
      }
      return [{ status_code: options.ncStatus ?? 'PENDING_DECISION' }];
    }),
    nonconformance_lot: { aggregate: jest.fn().mockResolvedValue({ _sum: { affected_qty: D(options.affected ?? 100) } }) },
    disposition_decision: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { decision_qty: D(options.decided ?? 0) }, _count: options.decided ? 1 : 0 }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => decisions.push(data)),
    },
    concession: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { concession_id: 7n };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => updates.push({ concession: data })),
    },
    nonconformance: { update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => updates.push({ nc: data })) },
    approval_request: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status_code: options.approvalStatus ?? 'APPROVED' }) },
  };
  const prisma = {
    nonconformance: {
      findUnique: jest.fn().mockResolvedValue({ status_code: 'PENDING_DECISION', nonconformance_lot: [{ lot_id: 10n, uom_id: 1n }] }),
    },
    uom: { findUniqueOrThrow: jest.fn().mockResolvedValue({ decimal_scale: 0 }) },
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaService;
  const numbering = { next: jest.fn(async (type: string) => (type === 'CONCESSION' ? 'CNC-1' : 'AP-1')) } as unknown as NumberingService;
  const approvals = {
    request: jest.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      calls.push(`approval:${String(input.approvalTypeCode)}:${String(input.targetTypeCode)}`);
      return { approvalRequestId: 99n };
    }),
  } as unknown as ApprovalService;
  const documentState = { assertTransition: jest.fn().mockReturnValue({ to: 'DECIDED' }) } as unknown as DocumentStateService;
  const lots = {
    moveWithin: jest.fn(async (_tx: unknown, lotIds: bigint[], action: string) => {
      calls.push(`move:${action}`);
      return { movedLotIds: lotIds, skippedLotIds: [] };
    }),
  } as unknown as LotQualityStatusService;
  const holds = {
    lockLotsWithin: jest.fn().mockResolvedValue([]),
    releaseWithin: jest.fn(async (_tx: unknown, _locked: unknown, _target: unknown, release: { releaseReasonCode: string }) => {
      calls.push(`release:${release.releaseReasonCode}`);
      return { openAfter: 0 };
    }),
  } as unknown as LotHoldService;
  const service = new ConcessionWriteService(prisma, numbering, approvals, documentState, lots, holds);
  return { service, calls, created, updates, decisions };
};

const body = (extra: Partial<ConcessionCreate> = {}): ConcessionCreate => ({
  nonconformanceId: 41, lotId: 10, approvedQty: 30, uomId: 1, validFrom: '2026-10-16', validTo: '2026-11-15',
  reason: '외관 경미 — 조건부 사용', ...extra,
});

describe('ConcessionWriteService.request', () => {
  it('특채(PENDING)와 결재(CONCESSION · 부적합 대상)를 함께 만든다', async () => {
    const h = harness();
    await expect(h.service.request(body(), 9)).resolves.toBe(7);
    expect(h.calls).toEqual(['approval:CONCESSION:NONCONFORMANCE']);
    expect(h.created[0]).toMatchObject({
      concession_no: 'CNC-1', nonconformance_id: 41n, lot_id: 10n, status_code: 'PENDING',
      approval_request_id: 99n, remarks: '외관 경미 — 조건부 사용',
    });
  });

  it('부적합의 LOT 이 아니거나 남은 수량을 넘거나 사유가 비면 400 이다', async () => {
    await expect(harness().service.request(body({ lotId: 11 }), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness({ decided: 80 }).service.request(body(), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness().service.request(body({ reason: '  ' }), 9)).rejects.toBeInstanceOf(ContractException);
    await expect(harness().service.request(body({ validTo: '2026-10-01' }), 9)).rejects.toBeInstanceOf(ContractException);
  });
});

describe('ConcessionWriteService.apply', () => {
  it('승인이면 처분 판정(CONCESSION)·LOT 정상(C25)·보류 해제(CONCESSION_APPROVED)·특채 APPROVED', async () => {
    const h = harness({ affected: 30 });
    await h.service.apply(7, 9);
    expect(h.decisions[0]).toMatchObject({ disposition_type_code: 'CONCESSION', decision_qty: D(30), approval_request_id: 99n });
    expect(h.calls).toEqual(['move:concession-apply', 'release:CONCESSION_APPROVED']);
    expect(h.updates).toEqual([
      { nc: expect.objectContaining({ status_code: 'DECIDED' }) },
      { concession: expect.objectContaining({ status_code: 'APPROVED' }) },
    ]);
  });

  it('남은 수량이 있으면 부적합을 닫지 않는다', async () => {
    const h = harness({ affected: 100 });
    await h.service.apply(7, 9);
    expect(h.updates[0]).toEqual({ nc: expect.not.objectContaining({ status_code: 'DECIDED' }) });
  });

  it('결재 진행 중이면 400, 반려면 특채를 REJECTED 로 닫고 LOT 은 그대로다', async () => {
    await expect(harness({ approvalStatus: 'PENDING' }).service.apply(7, 9)).rejects.toBeInstanceOf(ContractException);
    const rejected = harness({ approvalStatus: 'REJECTED' });
    await rejected.service.apply(7, 9);
    expect(rejected.updates).toEqual([{ concession: expect.objectContaining({ status_code: 'REJECTED' }) }]);
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

  it('남은 수량이 승인 수량과 같으면 적용하고 부적합을 닫는다', async () => {
    const h = harness({ affected: 100, decided: 70 });
    await h.service.apply(7, 9);
    expect(h.decisions).toHaveLength(1);
    expect(h.updates[0]).toEqual({ nc: expect.objectContaining({ status_code: 'DECIDED' }) });
  });

  it('이미 적용된 특채는 400 이다', async () => {
    await expect(harness({ concessionStatus: 'APPROVED' }).service.apply(7, 9)).rejects.toBeInstanceOf(ContractException);
  });
});

it('없는 부적합은 404', async () => {
  const h = harness();
  (h.service as unknown as { prisma: { nonconformance: { findUnique: jest.Mock } } }).prisma.nonconformance.findUnique.mockResolvedValueOnce(null);
  await expect(h.service.request(body(), 9)).rejects.toBeInstanceOf(NotFoundException);
});
