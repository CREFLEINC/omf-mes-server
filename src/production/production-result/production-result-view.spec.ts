import { Prisma } from '@prisma/client';

import { ProductionResultRow, productionResultView } from './production-result-view';

const OCCURRED_AT = new Date('2026-09-06T02:00:00.000Z');
const RECORDED_AT = new Date('2026-09-06T02:00:05.000Z');

/** 다섯 수량이 «전부 0» 인 행 — required 14 가 0 을 값으로 내는지 보는 자리다. */
function row(overrides: Partial<ProductionResultRow> = {}): ProductionResultRow {
  return {
    production_result_id: 501n,
    production_result_no: 'PR-260906-0001',
    work_order_id: 900n,
    work_session_id: null,
    result_sequence: 1,
    corrects_production_result_id: null,
    good_qty: new Prisma.Decimal(0),
    defect_qty: new Prisma.Decimal(0),
    hold_qty: new Prisma.Decimal(0),
    scrap_qty: new Prisma.Decimal(0),
    rework_qty: new Prisma.Decimal(0),
    uom_id: 7n,
    result_source_code: 'MANUAL',
    occurred_at: OCCURRED_AT,
    recorded_at: RECORDED_AT,
    late_entry_reason_code: null,
    worker_id: 11n,
    equipment_id: null,
    mold_id: null,
    shift_id: null,
    terminal_id: null,
    status_code: 'CONFIRMED',
    idempotency_key: 'key-1',
    remarks: null,
    created_at: RECORDED_AT,
    created_by: null,
    updated_at: RECORDED_AT,
    updated_by: null,
    version_no: 1,
    correct_reason_code: null,
    ...overrides,
  };
}

describe('생산 실적 뷰 (I-7 PR ①)', () => {
  it('뷰 — 값 없는 칸은 키를 생략한다(널을 안 보낸다)', () => {
    const view = productionResultView(row());

    // 선택 9칸이 전부 NULL 인 행 — 널을 내리면 계약의 「선택 필드」와 뜻이 갈린다.
    for (const key of [
      'workSessionId',
      'correctsProductionResultId',
      'lateEntryReasonCode',
      'equipmentId',
      'moldId',
      'shiftId',
      'terminalId',
      'remarks',
    ]) {
      expect(Object.keys(view)).not.toContain(key);
    }
    expect(Object.values(view)).not.toContain(null);
    // ⛔ 계약 `ProductionResult` 에 없는 칸은 내지 않는다 — D2 사유 칸과 낙관적 잠금 토큰.
    expect(Object.keys(view)).not.toContain('correctReasonCode');
    expect(Object.keys(view)).not.toContain('versionNo');
  });

  it('뷰 — required 14 는 값이 0 이어도 «값»으로 낸다', () => {
    const view = productionResultView(row());

    // 다섯 수량이 0 이라도 키가 살아 있어야 계약 required 를 만족한다.
    expect(view).toEqual({
      productionResultId: 501,
      productionResultNo: 'PR-260906-0001',
      workOrderId: 900,
      resultSequence: 1,
      goodQty: 0,
      defectQty: 0,
      holdQty: 0,
      scrapQty: 0,
      reworkQty: 0,
      uomId: 7,
      resultSourceCode: 'MANUAL',
      occurredAt: OCCURRED_AT.toISOString(),
      // `recorded_at` 은 물리가 NOT NULL(DEFAULT clock_timestamp())이라 언제나 실린다.
      recordedAt: RECORDED_AT.toISOString(),
      workerId: 11,
      statusCode: 'CONFIRMED',
    });
  });

  it('뷰 — `shiftId` 가 NULL 이면 키가 없다', () => {
    // D1 이 NOT NULL 을 풀었고 계약 `ProductionResultCreate` 에 칸이 없어 새 행은 늘 비운다.
    expect(Object.keys(productionResultView(row({ shift_id: null })))).not.toContain('shiftId');
    expect(productionResultView(row({ shift_id: 3n }))).toMatchObject({ shiftId: 3 });
  });
});
