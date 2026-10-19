import { ContractException } from '../../common/errors';
import { dashboardRange, previousRange } from './dashboard-range';

const TODAY = '2026-10-16';

function errorsOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(400);
    return (error as ContractException).errors.map(({ field, code }) => ({ field, code }));
  }
  throw new Error('400 이 나지 않았다');
}

describe('dashboard range', () => {
  it('아무것도 없으면 오늘 하루, baseDate 만 오면 그 하루다 — baseDate 는 미래도 받는다(하위 호환)', () => {
    expect(dashboardRange({}, TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(dashboardRange({ baseDate: '2026-12-01' }, TODAY)).toEqual({ from: '2026-12-01', to: '2026-12-01' });
  });

  it('dateFrom~dateTo 는 양 끝 포함 92일까지 받고 93일은 거절한다', () => {
    expect(dashboardRange({ dateFrom: '2026-07-17', dateTo: TODAY }, TODAY)).toEqual({ from: '2026-07-17', to: TODAY });
    expect(errorsOf(() => dashboardRange({ dateFrom: '2026-07-16', dateTo: TODAY }, TODAY))).toEqual([
      { field: 'dateTo', code: 'RANGE' },
    ]);
  });

  it('순서가 뒤집히거나 종료일이 미래면 RANGE 다', () => {
    expect(errorsOf(() => dashboardRange({ dateFrom: '2026-10-10', dateTo: '2026-10-09' }, TODAY))).toEqual([
      { field: 'dateFrom', code: 'RANGE' },
    ]);
    expect(errorsOf(() => dashboardRange({ dateFrom: '2026-10-10', dateTo: '2026-10-17' }, TODAY))).toEqual([
      { field: 'dateTo', code: 'RANGE' },
    ]);
  });

  it('하나만 오면 빠진 쪽 REQUIRED, baseDate 와 함께 오면 INVALID, 형식·실재하지 않는 날짜는 INVALID 다', () => {
    expect(errorsOf(() => dashboardRange({ dateFrom: '2026-10-10' }, TODAY))).toEqual([
      { field: 'dateTo', code: 'REQUIRED' },
    ]);
    expect(errorsOf(() => dashboardRange({ baseDate: TODAY, dateFrom: TODAY, dateTo: TODAY }, TODAY))).toEqual([
      { field: 'baseDate', code: 'INVALID' },
    ]);
    expect(errorsOf(() => dashboardRange({ dateFrom: '2026-02-30', dateTo: '20261016' }, TODAY))).toEqual([
      { field: 'dateFrom', code: 'INVALID' },
      { field: 'dateTo', code: 'INVALID' },
    ]);
  });

  it('바로 앞 같은 길이 기간 — 하루면 전일, 월 경계를 넘는다', () => {
    expect(previousRange({ from: TODAY, to: TODAY })).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(previousRange({ from: '2026-10-01', to: '2026-10-03' })).toEqual({ from: '2026-09-28', to: '2026-09-30' });
  });
});
