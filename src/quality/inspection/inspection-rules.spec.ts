import { ContractException } from '../../common/errors';
import {
  assertConfirmedShape,
  assertMeasurementValues,
  assertPeriodPair,
  assertQuantityBounds,
  assertScopedOrPeriod,
  buildInspectionResultOrderBy,
} from './inspection-rules';

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

describe('assertConfirmedShape — 확정 행의 두 규칙', () => {
  const base = { statusCode: 'CONFIRMED', inspectedQty: 100, acceptedQty: 60, rejectedQty: 30, heldQty: 10, overallJudgmentCode: 'ACCEPTED' };

  it('작성중은 합도 판정도 안 본다 — M-e ⓑ·ⓒ 가 물리를 그 모양으로 풀었다', () => {
    expect(() => assertConfirmedShape({ ...base, statusCode: 'DRAFT', acceptedQty: 0, rejectedQty: 0, heldQty: 0, overallJudgmentCode: undefined })).not.toThrow();
  });

  it('확정인데 판정이 없으면 400 `REQUIRED`', () => {
    expect(() => assertConfirmedShape({ ...base, overallJudgmentCode: undefined })).toThrow(ContractException);
  });

  it('확정인데 합이 다르면 400 `INVALID`', () => {
    expect(() => assertConfirmedShape({ ...base, heldQty: 11 })).toThrow(ContractException);
  });

  it('⭐ 소수 자릿수 합을 부동소수로 재지 않는다 — `Decimal(20,6)` 자리로 옮겨 센다', () => {
    // 0.1 + 0.2 !== 0.3 이라 그대로 비교하면 DB CHECK 는 통과하는 입력을 서비스가 400 으로 막는다.
    expect(() => assertConfirmedShape({ ...base, inspectedQty: 0.3, acceptedQty: 0.1, rejectedQty: 0.2, heldQty: 0 })).not.toThrow();
  });
});

describe('assertMeasurementValues — 값은 한 칸만', () => {
  it('전부 비는 것은 통과다 — 「미측정」 갈래', () => {
    expect(() => assertMeasurementValues([{}])).not.toThrow();
  });

  it('두 칸이 차 있으면 400 — `ck_measurement_single_value` 를 앞당겨 잡는다', () => {
    expect(() => assertMeasurementValues([{ numericValue: 1, textValue: '가' }])).toThrow(ContractException);
  });
});


describe('assertQuantityBounds — 물리 하한을 400 으로 앞당긴다', () => {
  it('검사 수량 0 은 400 — `inspection_result_inspected_qty_check` 는 조건이 없어 작성중에도 산다', () => {
    expect(() => assertQuantityBounds({ inspectedQty: 0 })).toThrow(ContractException);
    expect(() => assertQuantityBounds({ inspectedQty: -1 })).toThrow(ContractException);
  });

  it('합격·불합격·보류 음수는 400 — 도메인 `app.qty_t` 가 `VALUE >= 0` 이다', () => {
    expect(() => assertQuantityBounds({ acceptedQty: -1 })).toThrow(ContractException);
    expect(() => assertQuantityBounds({ rejectedQty: -0.000001 })).toThrow(ContractException);
    expect(() => assertQuantityBounds({ heldQty: -1 })).toThrow(ContractException);
    expect(() => assertQuantityBounds({ acceptedQty: 0, rejectedQty: 0, heldQty: 0 })).not.toThrow();
  });

  it('표본 번호 0 은 400 — `inspection_measurement_sample_no_check`', () => {
    expect(() => assertQuantityBounds({ measurements: [{ sampleNo: 0 }] })).toThrow(ContractException);
    expect(() => assertQuantityBounds({ measurements: [{ sampleNo: 1 }] })).not.toThrow();
  });

  it('⭐ 생략한 칸은 안 본다 — `PUT` 은 보낸 칸만 고친다', () => {
    expect(() => assertQuantityBounds({})).not.toThrow();
    expect(() => assertQuantityBounds({ inspectedQty: 100 })).not.toThrow();
  });

  it('어긋난 칸을 한 응답에 모아 낸다 — 화면이 한 번에 고친다', () => {
    try {
      assertQuantityBounds({ inspectedQty: 0, acceptedQty: -1, measurements: [{ sampleNo: 0 }] });
      throw new Error('던졌어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractException);
      expect((error as ContractException).errors.map((item) => item.field)).toEqual([
        'inspectedQty',
        'acceptedQty',
        'measurements[0].sampleNo',
      ]);
    }
  });
});
