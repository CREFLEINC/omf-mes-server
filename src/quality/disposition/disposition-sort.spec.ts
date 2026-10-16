import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { assertSortShape, DispositionSortService } from './disposition-sort';

/** omf-all-around#108 — 처분 선별(장부 P-53). */

const ctx = {
  nonconformanceId: 1n, decisionId: 5n, lotIds: [10n], decisionQty: 100, uomId: 1, uomScale: 0,
  reason: '외관 선별', appUserId: 9, decidedAt: new Date('2026-10-16T00:00:00Z'), splitNonconformanceNo: 'NC-2',
};

const balance = (qty: number) => ({
  item_id: 7n, plant_id: 3n, warehouse_id: 4n, location_id: 6n, quality_status_code: 'Q',
  inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWN', owner_partner_id: null,
  on_hand_qty: new Prisma.Decimal(qty),
});

const harness = (balances: unknown[]) => {
  const moves: { lotIds: bigint[]; action: string }[] = [];
  const posted: { lines: unknown[] }[] = [];
  const createdNc: Record<string, unknown>[] = [];
  const createdNcLot: Record<string, unknown>[] = [];
  const lots = {
    moveWithin: jest.fn(async (_tx: unknown, lotIds: bigint[], action: string) => {
      moves.push({ lotIds, action });
      return { movedLotIds: lotIds, skippedLotIds: [] };
    }),
  } as unknown as LotQualityStatusService;
  const posting = {
    post: jest.fn(async (_tx: unknown, input: { lines: unknown[] }) => posted.push(input)),
  } as unknown as InventoryPostingService;
  const tx = {
    lot: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        lot_no: 'LOT-1', item_id: 7n, lot_type_code: 'PRODUCTION', plant_id: 3n, uom_id: 1n,
        status_code: 'INSPECTION_PENDING', manufactured_at: null, expiry_date: null, bom_id: null,
      }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ lot_id: 91n, lot_no: 'LOT-1-S1' }),
    },
    lot_relation: { create: jest.fn() },
    inventory_balance: { findMany: jest.fn().mockResolvedValue(balances) },
    nonconformance: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        nonconformance_no: 'NC-1', item_id: 7n, work_order_id: 41n, inspection_result_id: null,
        severity_code: 'MAJOR', responsible_department_id: null,
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdNc.push(data);
        return { nonconformance_id: 2n, nonconformance_no: data.nonconformance_no };
      }),
    },
    nonconformance_lot: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => createdNcLot.push(data)) },
  } as unknown as Prisma.TransactionClient;
  const holds = {
    lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 90n }]),
    releaseWithin: jest.fn().mockResolvedValue({ released: [], openAfter: 0 }),
  } as unknown as LotHoldService;
  return { service: new DispositionSortService(lots, posting, holds), tx, moves, posted, createdNc, createdNcLot, holds };
};

const body = (accepted: number, rejected: number) => ({ acceptedQty: accepted, rejectedQty: rejected, businessDate: '2026-10-16' });

describe('assertSortShape', () => {
  it('양품 + 불량 = 판정 수량, 업무 일자, LOT 하나를 요구한다', () => {
    expect(() => assertSortShape({ ...body(70, 30), decisionQty: 100 }, 1, 0)).not.toThrow();
    expect(() => assertSortShape({ ...body(70, 20), decisionQty: 100 }, 1, 0)).toThrow(ContractException);
    expect(() => assertSortShape({ acceptedQty: 70, rejectedQty: 30, decisionQty: 100 }, 1, 0)).toThrow(ContractException);
    expect(() => assertSortShape({ rejectedQty: 30, businessDate: '2026-10-16', decisionQty: 30 }, 1, 0)).toThrow(ContractException);
    expect(() => assertSortShape({ ...body(70, 30), decisionQty: 100 }, 2, 0)).toThrow(ContractException);
  });
});

describe('DispositionSortService', () => {
  it('불량분을 자식 LOT 으로 떼어 재고를 옮기고, 불량·새 부적합으로 넘기고, 원 LOT 은 정상이다', async () => {
    const h = harness([balance(100)]);
    await expect(h.service.applyWithin(h.tx, body(70, 30), ctx)).resolves.toEqual({
      splitLotId: 91, splitLotNo: 'LOT-1-S1', splitNonconformanceId: 2, splitNonconformanceNo: 'NC-2',
    });
    expect(h.posted[0]?.lines).toEqual([
      expect.objectContaining({ lotId: 10, qty: 30, from: expect.objectContaining({ locationId: 6 }) }),
      expect.objectContaining({ lotId: 91, qty: 30, to: expect.objectContaining({ locationId: 6 }) }),
    ]);
    expect(h.moves).toEqual([
      { lotIds: [91n], action: 'disposition-sort-defect' },
      { lotIds: [10n], action: 'disposition-sort' },
    ]);
    expect(h.createdNc[0]).toMatchObject({ nonconformance_no: 'NC-2', status_code: 'PENDING_DECISION', work_order_id: 41n });
    expect(h.createdNcLot[0]).toMatchObject({ lot_id: 91n, quality_status_before_code: 'DEFECTIVE' });
  });

  /* 장부 P-63 — 양품분(원 LOT)의 수입검사 대기 보류를 닫아 입고·피킹으로 잇는다. 불량분 자식은 손대지 않는다. */
  it('양품분 원 LOT 의 수입검사 대기 보류만 처분 정상 사유로 닫는다', async () => {
    const h = harness([balance(100)]);
    await h.service.applyWithin(h.tx, body(70, 30), ctx);

    expect(h.holds.releaseWithin).toHaveBeenCalledTimes(1);
    expect(h.holds.releaseWithin).toHaveBeenCalledWith(
      h.tx,
      expect.any(Array),
      { lotId: 10n, reasonCode: 'INCOMING_INSPECTION_WAIT' },
      { releaseReasonCode: 'DISPOSITION_NORMAL' },
      expect.objectContaining({ at: expect.any(Date) }),
    );
  });

  it('재고가 없는 LOT(공정 중)은 LOT 기록만 나눈다', async () => {
    const h = harness([]);
    await h.service.applyWithin(h.tx, body(70, 30), ctx);
    expect(h.posted).toHaveLength(0);
    expect(h.moves.map((move) => move.action)).toEqual(['disposition-sort-defect', 'disposition-sort']);
  });

  it('재고가 여러 위치에 있거나 불량 수량이 재고보다 많으면 400 이다', async () => {
    const many = harness([balance(50), balance(50)]);
    await expect(many.service.applyWithin(many.tx, body(70, 30), ctx)).rejects.toBeInstanceOf(ContractException);
    const short = harness([balance(10)]);
    await expect(short.service.applyWithin(short.tx, body(70, 30), ctx)).rejects.toBeInstanceOf(ContractException);
  });

  it('불량이 0 이면 나누지 않고 원 LOT 만 정상으로 보낸다', async () => {
    const h = harness([balance(100)]);
    await expect(h.service.applyWithin(h.tx, body(100, 0), ctx)).resolves.toBeNull();
    expect(h.moves).toEqual([{ lotIds: [10n], action: 'disposition-sort' }]);
    expect(h.posted).toHaveLength(0);
    expect(h.createdNc).toHaveLength(0);
  });
});
