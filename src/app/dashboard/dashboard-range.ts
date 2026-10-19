import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';

/** 조회 기간 — 공장 현지 달력 날짜, 양 끝 포함. */
export interface DashboardRange {
  readonly from: string;
  readonly to: string;
}

export const MAX_RANGE_DAYS = 92;
const DAY_MS = 86_400_000;

export interface DashboardRangeQuery {
  baseDate?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * ⛔ `dateFrom`·`dateTo` 는 계약 사본에 없다(장부 P-59) — 계약 검증 가드는 사본에 없는 질의를
 * 그냥 통과시키므로 형식·순서·길이·미래를 «여기서» 막는다. 오류 모양은 가드와 같다.
 * `baseDate` 는 하위 호환이라 미래 날짜를 막지 않는다(지금도 200).
 */
export function dashboardRange(query: DashboardRangeQuery, today: string): DashboardRange {
  const { baseDate, dateFrom, dateTo } = query;
  if (dateFrom === undefined && dateTo === undefined) {
    const day = baseDate ?? today;
    return { from: day, to: day };
  }
  if (baseDate !== undefined) {
    throw invalid([error('baseDate', ERROR_CODE.INVALID, 'baseDate 와 dateFrom·dateTo 는 함께 쓸 수 없습니다.')]);
  }
  const missing = [
    ...(dateFrom === undefined ? [error('dateFrom', ERROR_CODE.REQUIRED, 'dateTo 와 함께 보내야 합니다.')] : []),
    ...(dateTo === undefined ? [error('dateTo', ERROR_CODE.REQUIRED, 'dateFrom 과 함께 보내야 합니다.')] : []),
  ];
  if (missing.length > 0) throw invalid(missing);
  const malformed = [
    ...(isDate(dateFrom) ? [] : [error('dateFrom', ERROR_CODE.INVALID, 'YYYY-MM-DD 날짜여야 합니다.')]),
    ...(isDate(dateTo) ? [] : [error('dateTo', ERROR_CODE.INVALID, 'YYYY-MM-DD 날짜여야 합니다.')]),
  ];
  if (malformed.length > 0) throw invalid(malformed);
  const from = dateFrom as string;
  const to = dateTo as string;
  if (from > to) throw invalid([error('dateFrom', ERROR_CODE.RANGE, 'dateTo 보다 늦을 수 없습니다.')]);
  if (to > today) throw invalid([error('dateTo', ERROR_CODE.RANGE, '오늘 이후 날짜는 조회할 수 없습니다.')]);
  if (rangeDays({ from, to }) > MAX_RANGE_DAYS) {
    throw invalid([error('dateTo', ERROR_CODE.RANGE, `기간은 ${MAX_RANGE_DAYS}일 이하여야 합니다.`)]);
  }
  return { from, to };
}

/** 양 끝 포함 일수. */
export function rangeDays(range: DashboardRange): number {
  return (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS + 1;
}

/** 바로 앞 같은 길이 기간 — 하루면 전일이다. */
export function previousRange(range: DashboardRange): DashboardRange {
  const length = rangeDays(range);
  const to = shiftDate(range.from, -1);
  return { from: shiftDate(to, -(length - 1)), to };
}

/** 양 끝 포함 날짜(오름차순). */
export function datesBetween(range: DashboardRange): string[] {
  return Array.from({ length: rangeDays(range) }, (_, index) => shiftDate(range.from, index));
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isDate(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function error(field: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field, code, message };
}

function invalid(items: ErrorItem[]): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, items);
}
