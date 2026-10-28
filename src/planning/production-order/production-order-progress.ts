import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * ERP W/O 진행 — 계약 밖(장부 P-133). 건수로 판정하고 취소된 MES W/O 는 없는 것으로 친다.
 * ⚠ MES W/O 의 COMPLETED(생산 완료)는 마감이 아니다 — CLOSED 만 센다. 수량을 덜 전개해도 전개한 W/O 가 다 마감이면 COMPLETED 다.
 * ⛔ 판정을 바꾸면 `progressStatusCode`·`progressWhere`·`progressSql` 세 곳을 함께 고친다.
 */
export type ProductionOrderProgressStatus = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED' | 'CANCELLED';
type ProductionOrderProgress = 'OPEN' | 'COMPLETED';

export function progressStatusCode(statusCode: string, liveWorkOrders: number, closedWorkOrders: number): ProductionOrderProgressStatus {
  if (statusCode === 'CANCELLED') return 'CANCELLED';
  if (closedWorkOrders === 0) return 'NOT_STARTED';
  return closedWorkOrders === liveWorkOrders ? 'COMPLETED' : 'PARTIAL';
}

/** `progress=COMPLETED` 는 진행 코드 COMPLETED·CANCELLED, `OPEN` 은 그 나머지다 — 합치면 전체. */
export function progressWhere(value: string | undefined): Prisma.production_orderWhereInput {
  const progress = progressOf(value);
  if (progress === undefined) return {};
  const completed: Prisma.production_orderWhereInput = {
    OR: [
      { status_code: 'CANCELLED' },
      {
        AND: [
          { production_plan: { some: { work_order: { some: { status_code: { not: 'CANCELLED' } } } } } },
          { production_plan: { none: { work_order: { some: { status_code: { notIn: ['CLOSED', 'CANCELLED'] } } } } } },
        ],
      },
    ],
  };
  return progress === 'COMPLETED' ? completed : { NOT: completed };
}

export function progressSql(value: string | undefined): Prisma.Sql | undefined {
  const progress = progressOf(value);
  if (progress === undefined) return undefined;
  const workOrders = (condition: Prisma.Sql): Prisma.Sql => Prisma.sql`EXISTS (
    SELECT 1 FROM production.work_order w JOIN planning.production_plan p ON p.production_plan_id = w.production_plan_id
     WHERE p.production_order_id = o.production_order_id AND ${condition})`;
  const completed = Prisma.sql`(o.status_code = 'CANCELLED'
    OR (${workOrders(Prisma.sql`w.status_code <> 'CANCELLED'`)}
        AND NOT ${workOrders(Prisma.sql`w.status_code NOT IN ('CLOSED', 'CANCELLED')`)}))`;
  return progress === 'COMPLETED' ? completed : Prisma.sql`NOT ${completed}`;
}

function progressOf(value: string | undefined): ProductionOrderProgress | undefined {
  if (value === undefined) return undefined;
  // ⛔ 틀린 값을 무시하지 않는다 — 걸러지지 않은 전체가 한쪽처럼 보인다.
  if (value !== 'OPEN' && value !== 'COMPLETED') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field: 'progress', code: ERROR_CODE.INVALID, message: 'progress 는 OPEN 또는 COMPLETED 여야 합니다.' },
    ]);
  }
  return value;
}
