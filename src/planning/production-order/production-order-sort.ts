import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * ERP W/O 목록 정렬(`sort`) — 축은 계획 시작일 하나다. ERP W/O 는 납기 없이 계획 시작일만 와서 시작일이 먼저다(사용자 결정
 * 2026-10-20). 방향은 시작일에만 건다 — 같은 날은 늘 납기 → id 오름차순이고(사용자 요청 2026-11-27), 시작일이 없는
 * 테스트용 등록분(P-30)은 방향과 상관없이 맨 뒤다.
 */
export type ProductionOrderSort = 'asc' | 'desc';

const SORTS = ['plannedStartDate', 'plannedStartDate,asc', 'plannedStartDate,desc'] as const;

/** 없거나 방향을 빼면 asc — 지금까지의 고정 순서다. */
export function assertSort(value: string | undefined): ProductionOrderSort {
  if (value === undefined) return 'asc';
  if ((SORTS as readonly string[]).includes(value)) return value.endsWith(',desc') ? 'desc' : 'asc';
  throw new ContractException(HttpStatus.BAD_REQUEST, [{
    scope: 'field', field: 'sort', code: ERROR_CODE.INVALID,
    message: `${SORTS.join(' · ')} 중 하나입니다.`,
  }]);
}

export function orderByOf(sort: ProductionOrderSort): Prisma.production_orderOrderByWithRelationInput[] {
  return [
    { planned_start_date: { sort, nulls: 'last' } },
    { due_date: { sort: 'asc', nulls: 'last' } },
    { production_order_id: 'asc' },
  ];
}

/** `orderByOf` 의 SQL 판 — `listBySql` 의 `o` 별칭에 건다. ⛔ 둘을 함께 고친다. */
export function orderSqlOf(sort: ProductionOrderSort): Prisma.Sql {
  const startDate = sort === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return Prisma.sql`ORDER BY o.planned_start_date ${startDate} NULLS LAST, o.due_date ASC NULLS LAST, o.production_order_id ASC`;
}
