import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { dispositionsByNonconformance } from './disposition-by-nonconformance';
import { DispositionDecisionRow } from './disposition-view';

/**
 * `disposition-by-nonconformance.ts` 단위 시험. `$queryRawUnsafe`·`nonconformance.findUnique`
 * 를 스텁으로 갈아 끼운다(0단계 선례 `disposition.controller.spec.ts`) — e2e 는 실제 잔량
 * 산식의 정확한 소수 경계까지 매 케이스 픽스처를 새로 심어야 해 비싸다.
 */
const ROW: DispositionDecisionRow = {
  disposition_decision_id: 1,
  nonconformance_id: 10,
  disposition_type_code: 'REWORK',
  decision_qty: '25.000000',
  uom_id: 100,
  reason: '사유',
  decided_by: 200,
  decided_at: new Date('2026-09-01T00:00:00.000Z'),
  approval_request_id: null,
  nonconformance_no: 'NC-0001',
  item_id: 300,
  item_code: 'IT-1',
  item_name: '품목1',
  decided_by_name: '판정자',
  lot_id: 400,
  lot_no: 'LOT-1',
  posted_qty: '0',
};

interface FakeNonconformance {
  item: { base_uom_id: bigint };
  nonconformance_lot: { affected_qty: Prisma.Decimal; uom_id: bigint }[];
}

function fakePrisma(rows: DispositionDecisionRow[], nc: FakeNonconformance | null): PrismaService {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue(rows),
    nonconformance: { findUnique: jest.fn().mockResolvedValue(nc) },
  } as unknown as PrismaService;
}

describe('dispositionsByNonconformance', () => {
  it('⛔ 없는 nonconformanceId 는 404 가 아니다 — 빈 목록 + summary 전 칸 0(§1-1 · §1-6) // 결정 — 통보 후보(번호는 통합자가 준다)', async () => {
    const result = await dispositionsByNonconformance(fakePrisma([], null), 999999);

    expect(result).toEqual({
      items: [],
      page: { page: 1, size: 0, total: 0 },
      summary: { affectedQtyTotal: 0, decidedQtyTotal: 0, remainingQty: 0, uomId: 0 },
    });
  });

  it('대상 100 · 결정 25+35 → 잔량 40 · uomId 는 lot 의 단위', async () => {
    const rows = [
      { ...ROW, disposition_decision_id: 1, decision_qty: '25.000000' },
      { ...ROW, disposition_decision_id: 2, decision_qty: '35.000000' },
    ];
    const nc: FakeNonconformance = { item: { base_uom_id: 999n }, nonconformance_lot: [{ affected_qty: new Prisma.Decimal(100), uom_id: 100n }] };

    const result = await dispositionsByNonconformance(fakePrisma(rows, nc), 10);

    expect(result.summary).toEqual({ affectedQtyTotal: 100, decidedQtyTotal: 60, remainingQty: 40, uomId: 100 });
    expect(result.page).toEqual({ page: 1, size: 2, total: 2 });
  });

  it('⭐ lot 이 0행이면(물리가 막지 않는 상태) 품목 기준 단위로 접는다', async () => {
    const nc: FakeNonconformance = { item: { base_uom_id: 777n }, nonconformance_lot: [] };

    const result = await dispositionsByNonconformance(fakePrisma([], nc), 10);

    expect(result.summary).toMatchObject({ affectedQtyTotal: 0, uomId: 777 });
  });

  it('⭐⭐ numeric(20,6) 함정 — 0.1+0.2 결정이 0.3 대상과 «정확히» 맞아떨어진다(R-25 형)', async () => {
    // `Number()` 로 먼저 접었다면 0.1+0.2=0.30000000000000004 가 되어 remainingQty 가 0 이 아니게 샌다.
    const rows = [
      { ...ROW, disposition_decision_id: 1, decision_qty: '0.1' },
      { ...ROW, disposition_decision_id: 2, decision_qty: '0.2' },
    ];
    const nc: FakeNonconformance = { item: { base_uom_id: 100n }, nonconformance_lot: [{ affected_qty: new Prisma.Decimal('0.3'), uom_id: 100n }] };

    const result = await dispositionsByNonconformance(fakePrisma(rows, nc), 10);

    expect(result.summary.remainingQty).toBe(0);
  });

  it('⭐⭐ 리뷰 Major-1 — 대상(affected) «합»이 다중 LOT 전건이고 uomId 는 «첫» LOT 의 단위다', async () => {
    // 두 LOT 의 uom_id 를 다르게 두어 「lots[0] 만 합한다」·「마지막 LOT 의 uom 을 고른다」를 함께
    // 잡는다. affected_qty 를 0.1+0.2 로 심어 대상 쪽 R-25 함정(단위 시험 위에서 결정 쪽만
    // 잠갔던 자리)도 같은 픽스처로 닫는다.
    const nc: FakeNonconformance = {
      item: { base_uom_id: 999n },
      nonconformance_lot: [
        { affected_qty: new Prisma.Decimal('0.1'), uom_id: 100n },
        { affected_qty: new Prisma.Decimal('0.2'), uom_id: 200n },
      ],
    };

    const result = await dispositionsByNonconformance(fakePrisma([], nc), 10);

    expect(result.summary).toEqual({ affectedQtyTotal: 0.3, decidedQtyTotal: 0, remainingQty: 0.3, uomId: 100 });
  });
});
