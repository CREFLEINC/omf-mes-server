import type { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { allocateIqcNonconformanceNo, createIqcNonconformanceWithin } from './iqc-nonconformance';

/** omf-all-around#106 후속 (다) — IQC 불합격이 부적합을 세운다(장부 P-41). */
describe('IQC 불합격 → 부적합 자동 등록', () => {
  const request = { inspection_type_code: 'IQC', lot_id: 20n, item_id: 10n, uom_id: 1n, work_order_id: null };

  function tx(open: boolean) {
    const ncs: Record<string, unknown>[] = [];
    const lots: Record<string, unknown>[] = [];
    const client = {
      nonconformance_lot: {
        findFirst: jest.fn().mockResolvedValue(open ? { nonconformance_id: 1n } : null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => lots.push(data)),
      },
      defect_record: {
        findMany: jest.fn().mockResolvedValue([
          { defect_description: '긁힘', defect_code: { defect_code: 'APP-SCR', defect_name: '스크래치' } },
        ]),
      },
      nonconformance: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          ncs.push(data);
          return { nonconformance_id: 77n };
        }),
      },
    } as unknown as Prisma.TransactionClient;
    return { client, ncs, lots };
  }

  const input = { nonconformanceNo: 'NC-1', inspectionResultId: 40n, request, qty: 15, appUserId: 9, at: new Date('2026-10-16T02:00:00Z') };

  it('처분 대기 부적합과 대상 LOT(불량·불합격 수량)을 세우고 사유를 설명에 잇는다', async () => {
    const { client, ncs, lots } = tx(false);

    await expect(createIqcNonconformanceWithin(client, input)).resolves.toBe(77n);
    expect(ncs[0]).toMatchObject({
      nonconformance_no: 'NC-1',
      item_id: 10n,
      inspection_result_id: 40n,
      status_code: 'PENDING_DECISION',
      severity_code: 'MAJOR',
      description: '수입검사 불합격 — APP-SCR 스크래치: 긁힘',
      created_by: 9n,
    });
    expect(lots[0]).toMatchObject({
      nonconformance_id: 77n,
      lot_id: 20n,
      uom_id: 1n,
      quality_status_before_code: 'DEFECTIVE',
      quality_status_after_code: 'DEFECTIVE',
    });
    expect(String(lots[0].affected_qty)).toBe('15');
  });

  it('그 LOT 에 열린 부적합이 있으면 새로 만들지 않는다', async () => {
    const { client, ncs } = tx(true);

    await expect(createIqcNonconformanceWithin(client, input)).resolves.toBeNull();
    expect(ncs).toHaveLength(0);
  });

  describe('번호', () => {
    const numbering = { next: jest.fn().mockResolvedValue('NC-260916-0001') } as unknown as NumberingService;
    const prismaWith = (row: { inspection_type_code: string; lot_id: bigint | null }) =>
      ({ inspection_request: { findUnique: jest.fn().mockResolvedValue(row) } }) as unknown as PrismaService;

    beforeEach(() => (numbering.next as jest.Mock).mockClear());

    it('IQC 불합격(LOT 있음)만 번호를 받는다', async () => {
      const at = new Date('2026-10-16T02:00:00Z');
      await expect(
        allocateIqcNonconformanceNo(prismaWith({ inspection_type_code: 'IQC', lot_id: 20n }), numbering, 9n, 'REJECTED', at),
      ).resolves.toBe('NC-260916-0001');
      expect(numbering.next).toHaveBeenCalledWith('NONCONFORMANCE', null, '2026-10-16');
    });

    it.each([
      ['합격', { inspection_type_code: 'IQC', lot_id: 20n }, 'ACCEPTED'],
      ['PQC 불합격', { inspection_type_code: 'PQC', lot_id: null }, 'REJECTED'],
    ])('%s 은 번호를 태우지 않는다', async (_label, row, judgment) => {
      await expect(allocateIqcNonconformanceNo(prismaWith(row), numbering, 9n, judgment, new Date())).resolves.toBeUndefined();
      expect(numbering.next).not.toHaveBeenCalled();
    });
  });
});
