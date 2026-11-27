import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ConcessionCreate, ConcessionWriteService } from './concession-write.service';

/** omf-all-around#84 — 특채(장부 P-79) · 피처 005 — 특채는 남은 수량 전부(FR-038), LOT 이 여럿이면 LOT 마다 행(D-14) · 결재 없이 바로 적용(omf-all-around#352). */

const D = (value: number) => new Prisma.Decimal(value);

interface Options {
  decided?: number;
  affected?: number;
  ncStatus?: string;
  /** 요청 때 부적합 LOT — 기본은 LOT 10 하나(부적합 수량 30). */
  ncLots?: { lot_id: bigint; affected_qty: number }[];
}

const harness = (options: Options = {}) => {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const decisions: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: jest.fn(async () => [{ status_code: options.ncStatus ?? 'PENDING_DECISION' }]),
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
    },
    nonconformance: { update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => updates.push({ nc: data })) },
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
    next: jest.fn(async () => {
      concessionSeq += 1;
      return `CNC-${String(concessionSeq)}`;
    }),
  } as unknown as NumberingService;
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
  const service = new ConcessionWriteService(prisma, numbering, documentState, lots, holds);
  return { service, calls, created, updates, decisions, numbering };
};

const body = (extra: Partial<ConcessionCreate> = {}): ConcessionCreate => ({
  nonconformanceId: 41, lotId: 10, approvedQty: 30, uomId: 1, validFrom: '2026-10-16', validTo: '2026-11-15',
  reason: '외관 경미 — 조건부 사용', ...extra,
});

describe('ConcessionWriteService.request', () => {
  it('결재 없이 바로 적용한다 — 특채 APPROVED · 처분 판정(CONCESSION) · LOT 정상(C25) · 보류 해제 · 부적합 종결(omf-all-around#352)', async () => {
    const h = harness();
    await expect(h.service.request(body(), 9)).resolves.toEqual({ concessionIds: [7] });
    expect(h.calls).toEqual(['move:concession-apply:10', 'release:CONCESSION_APPROVED']);
    expect(h.numbering.next).toHaveBeenCalledTimes(1);
    expect(h.created[0]).toMatchObject({
      concession_no: 'CNC-1', nonconformance_id: 41n, lot_id: 10n, status_code: 'APPROVED',
      approval_request_id: null, remarks: '외관 경미 — 조건부 사용',
    });
    expect(h.decisions[0]).toMatchObject({ disposition_type_code: 'CONCESSION', decision_qty: D(30), approval_request_id: null });
    expect(h.updates).toEqual([{ nc: expect.objectContaining({ status_code: 'DECIDED' }) }]);
  });

  it('US4-4 lotId 를 비우면 부적합 LOT 마다 특채 행(그 LOT 의 부적합 수량) — 판정은 1건(합계)', async () => {
    const h = harness({ affected: 30, ncLots: [{ lot_id: 10n, affected_qty: 10 }, { lot_id: 11n, affected_qty: 20 }] });
    await expect(h.service.request(body({ lotId: undefined }), 9)).resolves.toEqual({ concessionIds: [7, 8] });
    expect(h.created.map((row) => [row.lot_id, row.approved_qty, row.status_code, row.concession_no])).toEqual([
      [10n, D(10), 'APPROVED', 'CNC-1'], [11n, D(20), 'APPROVED', 'CNC-2'],
    ]);
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]).toMatchObject({ decision_qty: D(30) });
    expect(h.calls).toEqual(['move:concession-apply:10', 'move:concession-apply:11', 'release:CONCESSION_APPROVED', 'release:CONCESSION_APPROVED']);
  });

  it('남은 수량이 특채 수량과 같으면(앞선 판정 70 · 남은 30) 적용해 부적합을 닫는다', async () => {
    const h = harness({ affected: 100, decided: 70 });
    await h.service.request(body(), 9);
    expect(h.decisions).toHaveLength(1);
    expect(h.updates[0]).toEqual({ nc: expect.objectContaining({ status_code: 'DECIDED' }) });
  });

  it('이미 종결된 부적합이면 400 이고 아무것도 만들지 않는다', async () => {
    const h = harness({ ncStatus: 'DECIDED' });
    await expect(h.service.request(body(), 9)).rejects.toBeInstanceOf(ContractException);
    expect(h.created).toEqual([]);
    expect(h.decisions).toEqual([]);
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

it('없는 부적합은 404', async () => {
  const h = harness();
  (h.service as unknown as { prisma: { nonconformance: { findUnique: jest.Mock } } }).prisma.nonconformance.findUnique.mockResolvedValueOnce(null);
  await expect(h.service.request(body(), 9)).rejects.toBeInstanceOf(NotFoundException);
});
