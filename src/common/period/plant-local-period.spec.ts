import { ContractException } from '../errors';
import { localPeriod, localPeriodSql, periodUnlessPinned, utcMarginSql } from './plant-local-period';

const FIELDS = { from: 'receiptDateFrom', to: 'receiptDateTo', label: '입고일' };
const TODAY = '2026-10-26';

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractException);
    return (error as ContractException).errors;
  }
  throw new Error('던지지 않았다');
}

describe('공장 현지 날짜 기간', () => {
  it('시작·종료를 그대로 돌려준다 — 종료는 선택이다', () => {
    expect(localPeriod('2026-10-01', '2026-10-26', FIELDS, TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-26' });
    expect(localPeriod('2026-10-01', undefined, FIELDS, TODAY)).toEqual({ from: '2026-10-01' });
  });

  it('시작이 없으면 400 REQUIRED 이고 칸·조치·상한을 알린다', () => {
    expect(errorOf(() => localPeriod(undefined, '2026-10-26', FIELDS, TODAY))).toEqual([{
      scope: 'field', field: 'receiptDateFrom', code: 'REQUIRED',
      message: '입고일 시작(receiptDateFrom)이 비었습니다. 시작일을 넣어 다시 조회하세요 — 기간은 최대 366일입니다.',
    }]);
  });

  it('종료가 시작보다 앞서면 400 INVALID 로 종료 칸을 짚는다', () => {
    expect(errorOf(() => localPeriod('2026-10-26', '2026-10-01', FIELDS, TODAY))).toEqual([{
      scope: 'field', field: 'receiptDateTo', code: 'INVALID',
      message: '입고일 종료(2026-10-01)가 시작(2026-10-26)보다 앞섭니다. 종료일을 시작일 이후로 고쳐 다시 조회하세요.',
    }]);
  });

  it('366일까지 받고 367일이면 400 RANGE — 종료가 없으면 오늘까지로 재고 시작 칸을 짚는다', () => {
    expect(localPeriod('2025-10-26', '2026-10-26', FIELDS, TODAY)).toEqual({ from: '2025-10-26', to: '2026-10-26' });
    expect(errorOf(() => localPeriod('2025-10-25', '2026-10-26', FIELDS, TODAY))).toEqual([{
      scope: 'field', field: 'receiptDateTo', code: 'RANGE',
      message: '입고일 기간이 367일입니다. 366일 이내로 줄여 다시 조회하세요.',
    }]);
    expect(errorOf(() => localPeriod('2025-10-25', undefined, FIELDS, TODAY))).toEqual([{
      scope: 'field', field: 'receiptDateFrom', code: 'RANGE',
      message: '입고일 기간이 367일입니다. 366일 이내로 줄여 다시 조회하세요 — 종료일을 넣지 않으면 오늘까지로 셉니다.',
    }]);
  });

  it('SQL 은 UTC 여유 경계와 행마다의 공장 자정 경계를 함께 건다 — 종료는 다음 날 자정 미만(포함)', () => {
    const params: unknown[] = [];
    const sql = localPeriodSql('gr.receipt_datetime', 'p.timezone_code', { from: '2026-10-01', to: '2026-10-26' },
      (value) => `$${params.push(value)}`);

    expect(params).toEqual(['2026-10-01', '2026-10-26']);
    expect(sql).toBe([
      "gr.receipt_datetime >= (($1::date - 1)::timestamp AT TIME ZONE 'UTC')",
      'gr.receipt_datetime >= (($1::date)::timestamp AT TIME ZONE p.timezone_code)',
      "gr.receipt_datetime < (($2::date + 2)::timestamp AT TIME ZONE 'UTC')",
      'gr.receipt_datetime < (($2::date + 1)::timestamp AT TIME ZONE p.timezone_code)',
    ].join(' AND '));
  });

  it('UTC 여유 경계만 거는 SQL 은 공장 시간대 없이 하루씩 넓게 잡는다 — 종료가 없으면 시작 쪽만', () => {
    const params: unknown[] = [];
    const bind = (value: unknown) => `$${params.push(value)}`;

    expect(utcMarginSql('pg.receipt_datetime', { from: '2026-10-01', to: '2026-10-26' }, bind)).toBe([
      "pg.receipt_datetime >= (($1::date - 1)::timestamp AT TIME ZONE 'UTC')",
      "pg.receipt_datetime < (($2::date + 2)::timestamp AT TIME ZONE 'UTC')",
    ].join(' AND '));
    expect(utcMarginSql('qr.occurred_at', { from: '2026-10-01' }, bind)).toBe("qr.occurred_at >= (($3::date - 1)::timestamp AT TIME ZONE 'UTC')");
    expect(params).toEqual(['2026-10-01', '2026-10-26', '2026-10-01']);
  });

  describe('기간이나 LOT 을 집는 번호(periodUnlessPinned)', () => {
    const PINS = '자재 LOT 번호(lotNo), 입하 번호(inboundReceiptNo)';

    it('기간만 있어도 된다 — 번호로 집지 않아도 그 기간 전체다', () => {
      expect(periodUnlessPinned('2026-10-01', '2026-10-26', FIELDS, false, PINS, '2026-10-26')).toEqual({ from: '2026-10-01', to: '2026-10-26' });
    });

    it('번호로 집었으면 기간은 선택이다', () => {
      expect(periodUnlessPinned(undefined, undefined, FIELDS, true, PINS, '2026-10-26')).toBeUndefined();
      expect(periodUnlessPinned('2026-10-01', undefined, FIELDS, true, PINS, '2026-10-26')).toEqual({ from: '2026-10-01' });
    });

    it('기간도 번호도 없으면 기간 시작 칸을 짚는 400 REQUIRED — 넣을 칸과 기간 상한을 알린다', () => {
      try {
        periodUnlessPinned(undefined, '2026-10-26', FIELDS, false, PINS, '2026-10-26');
        throw new Error('던지지 않았다');
      } catch (error) {
        expect((error as ContractException).errors).toEqual([{
          scope: 'field', field: 'receiptDateFrom', code: 'REQUIRED',
          message: '조회 기간이 없습니다. 입고일 시작(receiptDateFrom)을 넣거나 자재 LOT 번호(lotNo), 입하 번호(inboundReceiptNo) 중 하나를 넣어 다시 조회하세요. 기간은 최대 366일입니다.',
        }]);
      }
    });

    it('기간 검사(종료가 시작보다 앞섬·상한)는 그대로다', () => {
      expect(() => periodUnlessPinned('2026-10-26', '2026-10-01', FIELDS, false, PINS, '2026-10-26')).toThrow(ContractException);
      expect(() => periodUnlessPinned('2025-01-01', '2026-10-26', FIELDS, true, PINS, '2026-10-26')).toThrow(ContractException);
    });
  });
});
