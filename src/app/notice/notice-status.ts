import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';

/**
 * 공지의 «상태»와 «범위» 규칙.
 *
 * ⛔ **상태는 저장 컬럼이 아니다.** 계약이 그렇게 적었다 — 시작일·종료일과 오늘의 관계로
 * 파생한다. 아무도 아무것도 하지 않아도 자정을 넘기면 바뀌는 값이라 저장하면 그 순간부터
 * 틀린다. 물리 `notice.status_code` 컬럼은 있지만 **읽지 않는다**(되돌림 §Y-4).
 *
 * 그래서 「내려버리기」도 상태를 바꾸는 것이 아니라 **종료일을 오늘로 당기는 것**이다.
 */

export const NOTICE_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'CLOSED'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

/** 계약이 값을 다섯 두었으나 **1차는 둘만 유효하다** — 나머지는 400 이다(계약 명시). */
export const NOTICE_SCOPES = [
  'COMPANY',
  'WORK_ORDER',
  'BUSINESS_UNIT',
  'EQUIPMENT_GROUP',
  'WORK_SHIFT',
] as const;
export type NoticeScope = (typeof NOTICE_SCOPES)[number];
const SUPPORTED_SCOPES: NoticeScope[] = ['COMPANY', 'WORK_ORDER'];

export interface StatusSource {
  published_at: Date | null;
  start_date: Date | null;
  end_date: Date | null;
}

/**
 * 파생 순서가 계약의 정의 순서다.
 * `DRAFT`(게시 전) → `CLOSED`(종료일이 지났다) → `SCHEDULED`(아직 시작 전) → `PUBLISHED`.
 */
export function statusOf(row: StatusSource, today: string): NoticeStatus {
  if (row.published_at === null) return 'DRAFT';
  if (row.end_date !== null && dateOf(row.end_date) < today) return 'CLOSED';
  if (row.start_date !== null && dateOf(row.start_date) > today) return 'SCHEDULED';
  return 'PUBLISHED';
}

/** `@db.Date` 는 UTC 자정으로 저장된다 — 시각을 붙이면 하루가 어긋난다. */
export function dateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * 상태로 거르는 조건. 파생값이라 SQL 로는 «날짜 비교»가 된다 — 상태 문자열로 저장돼
 * 있었다면 못 걸렀을 자리다.
 */
export function statusWhere(status: NoticeStatus, today: Date): Record<string, unknown> {
  if (status === 'DRAFT') return { published_at: null };
  const published = { published_at: { not: null } };
  if (status === 'CLOSED') return { ...published, end_date: { lt: today } };
  if (status === 'SCHEDULED') return { ...published, start_date: { gt: today } };
  return {
    ...published,
    AND: [
      { OR: [{ start_date: null }, { start_date: { lte: today } }] },
      { OR: [{ end_date: null }, { end_date: { gte: today } }] },
    ],
  };
}

/**
 * 범위와 짝. `WORK_ORDER` 는 작업지시가 있어야 하고, 그 밖의 범위는 작업지시를 가질 수 없다.
 * 계약이 「둘의 짝이 어긋나면 400(code=PAIR)」로 못 박았다.
 */
export function assertScope(scopeCode: string, targetWorkOrderId: number | null | undefined): void {
  const errors: ErrorItem[] = [];
  if (!(SUPPORTED_SCOPES as string[]).includes(scopeCode)) {
    errors.push({
      scope: 'field',
      field: 'scopeCode',
      // 계약이 이름 붙인 값이다 — 「1차는 COMPANY·WORK_ORDER 만 유효하다」.
      code: 'SCOPE_NOT_SUPPORTED',
      message: `지금은 ${SUPPORTED_SCOPES.join(' · ')} 만 받습니다.`,
    });
  } else if (scopeCode === 'WORK_ORDER' && targetWorkOrderId == null) {
    errors.push(pair('targetWorkOrderId', '작업지시 범위에는 작업지시가 필요합니다.'));
  } else if (scopeCode !== 'WORK_ORDER' && targetWorkOrderId != null) {
    errors.push(pair('targetWorkOrderId', '이 범위에는 작업지시를 담지 않습니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function pair(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.PAIR, message };
}
