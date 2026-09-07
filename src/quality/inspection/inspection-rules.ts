import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';

/**
 * `inspection-results` 목록 — `inspectionRequestId` 도 기간도 없으면 400(계약 `:753`).
 * ⭐ R-17 — `summary`·`defect-rate-trend`(PR ⑤)의 「기간 무조건 필수」와 «다르다». 공용
 * 헬퍼로 뭉치면 `summary?inspectionRequestId=…` 가 조용히 200 을 낸다 — 이 함수는 이 목록 전용이다.
 */
export function assertScopedOrPeriod(query: {
  inspectionRequestId?: number;
  inspectedFrom?: string;
  inspectedTo?: string;
}): void {
  if (query.inspectionRequestId !== undefined) return;
  if (query.inspectedFrom !== undefined || query.inspectedTo !== undefined) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('inspectionRequestId', ERROR_CODE.REQUIRED, 'inspectionRequestId 또는 기간(inspectedFrom·inspectedTo) 중 하나가 필요합니다.'),
  ]);
}

/** 정렬 허용 3키(계약 `:859-861`). 동률은 `inspection_result_id` 로 닫는다. */
const SORT_KEYS = ['inspectionRequestNo', 'inspectedAt', 'rejectedQty'] as const;
type InspectionResultSortKey = (typeof SORT_KEYS)[number];

function orderByField(
  key: InspectionResultSortKey,
  direction: 'asc' | 'desc',
): Prisma.inspection_resultOrderByWithRelationInput {
  if (key === 'inspectionRequestNo') return { inspection_request: { inspection_request_no: direction } };
  if (key === 'inspectedAt') return { inspected_at: direction };
  return { rejected_qty: direction };
}

/**
 * `"키,asc|desc"` — 기본 `inspectedAt,desc`(계약). 허용 키·방향 밖은 400 `INVALID`(work-order
 * 정렬 화이트리스트 선례). ⭐ §4-2 — 이 순서는 **뿌리(1회차)** 사이의 순서다. 사슬 안은 항상
 * `inspection_round asc` — 이 함수가 관여하지 않는다.
 */
export function buildInspectionResultOrderBy(sort?: string): Prisma.inspection_resultOrderByWithRelationInput[] {
  const [rawKey, rawDirection] = (sort ?? 'inspectedAt,desc').split(',');
  const key = SORT_KEYS.find((candidate) => candidate === rawKey);
  const direction = rawDirection === undefined ? 'asc' : rawDirection;
  if (key === undefined || (direction !== 'asc' && direction !== 'desc')) {
    throw one(field('sort', ERROR_CODE.INVALID, `${SORT_KEYS.join(' · ')} 중 하나이고 asc·desc 만 받는다.`));
  }
  return [orderByField(key, direction), { inspection_result_id: 'asc' }];
}
