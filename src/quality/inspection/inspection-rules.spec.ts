import { assertPeriodPair, assertScopedOrPeriod, buildInspectionResultOrderBy } from './inspection-rules';

describe('assertScopedOrPeriod — inspectionRequestId 또는 기간 중 하나(계약 :753)', () => {
  it('⛔ 셋 다 없으면 400 REQUIRED 를 던진다', () => {
    expect(() => assertScopedOrPeriod({})).toThrow();
  });

  it('inspectionRequestId 만 있으면 통과한다', () => {
    expect(() => assertScopedOrPeriod({ inspectionRequestId: 1 })).not.toThrow();
  });

  it('기간을 쌍으로 주면 통과한다', () => {
    expect(() =>
      assertScopedOrPeriod({ inspectedFrom: '2026-09-01T00:00:00.000Z', inspectedTo: '2026-09-02T00:00:00.000Z' }),
    ).not.toThrow();
  });
});

describe('⭐ Major 2(리뷰) — assertPeriodPair: inspectedFrom·inspectedTo 는 한 쌍이다(계약 inspectedTo 설명)', () => {
  it('둘 다 없거나 둘 다 있으면 통과한다', () => {
    expect(() => assertPeriodPair({})).not.toThrow();
    expect(() => assertPeriodPair({ inspectedFrom: 'a', inspectedTo: 'b' })).not.toThrow();
  });

  it('⛔ 한쪽만 있으면 400 PAIR — 하한 없는 조회가 열리는 것을 막는다(L-3)', () => {
    expect(() => assertPeriodPair({ inspectedFrom: '2026-09-01T00:00:00.000Z' })).toThrow();
    expect(() => assertPeriodPair({ inspectedTo: '2026-09-01T00:00:00.000Z' })).toThrow();
  });
});

describe('buildInspectionResultOrderBy — 허용 3키 + 기본값', () => {
  it('생략하면 inspectedAt,desc 가 기본이다', () => {
    expect(buildInspectionResultOrderBy(undefined)).toEqual([
      { inspected_at: 'desc' },
      { inspection_result_id: 'asc' },
    ]);
  });

  it('허용 키·방향이면 그대로 쓰고 동률은 inspection_result_id 로 닫는다', () => {
    expect(buildInspectionResultOrderBy('rejectedQty,asc')).toEqual([
      { rejected_qty: 'asc' },
      { inspection_result_id: 'asc' },
    ]);
    expect(buildInspectionResultOrderBy('inspectionRequestNo,desc')).toEqual([
      { inspection_request: { inspection_request_no: 'desc' } },
      { inspection_result_id: 'asc' },
    ]);
  });

  it('⛔ 허용 3키 밖이면 400 INVALID', () => {
    expect(() => buildInspectionResultOrderBy('itemId,asc')).toThrow();
  });

  it('⛔ 방향이 asc·desc 밖이면 400 INVALID', () => {
    expect(() => buildInspectionResultOrderBy('inspectedAt,up')).toThrow();
  });
});
