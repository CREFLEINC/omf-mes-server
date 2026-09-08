import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/** `concession-query.ts` 의 `SELECT_COLUMNS` 가 내는 원시 행(선례 `disposition-view.ts`). */
export interface ConcessionRow {
  concession_id: bigint | number;
  concession_no: string;
  nonconformance_id: bigint | number;
  lot_id: bigint | number;
  approved_qty: unknown;
  consumed_qty: unknown;
  uom_id: bigint | number;
  valid_from: Date;
  valid_to: Date | null;
  allowed_work_order_id: bigint | number | null;
  allowed_process_id: bigint | number | null;
  allowed_customer_id: bigint | number | null;
  approval_request_id: bigint | number;
  status_code: string;
  remarks: string | null;
  nonconformance_no: string;
  lot_no: string;
}

/**
 * 계약 `Concession` 과 동형(required 10 / 프로퍼티 20). ⛔ `versionNo` 는 아예 싣지 않는다 —
 * 이 오퍼레이션엔 ETag·If-Match 가 없다(§1-1 · 공유계약 A-4 계열).
 */
export interface ConcessionView {
  concessionId: number;
  concessionNo: string;
  nonconformanceId: number;
  nonconformanceNo?: string;
  lotId: number;
  lotNo?: string;
  approvedQty: number;
  consumedQty: number;
  uomId: number;
  validFrom: string;
  validTo?: string;
  allowedWorkOrderId?: number;
  allowedProcessId?: number;
  allowedCustomerId?: number;
  unrestrictedAxes: string[];
  approvalRequestId: number;
  statusCode: string;
  usable: boolean;
  remarks?: string;
}

const APPROVED = 'APPROVED';

/**
 * ⭐⭐ R-13 널 정책(§1-4-0) — 선택 칸 **10** 전부 널 금지(키 생략): `nonconformanceNo`·`lotNo`·
 * `validTo`·`allowedWorkOrderId`·`allowedProcessId`·`allowedCustomerId`·`unrestrictedAxes`·
 * `usable`·`remarks`·`versionNo`. `usable`·`unrestrictedAxes` 는 파생값이라 항상 계산되므로
 * 실제로 생략되는 일은 없다(그래도 `omitEmpty` 로 감싼다 — 형태를 통일한다). `nonconformanceNo`·
 * `lotNo` 는 NOT NULL FK 조인이라 오늘은 늘 채워지지만 계약 모양대로 옵셔널로 싣는다.
 * ⛔ `numeric(20,6)` 은 `Prisma.Decimal` 로 비교하고 값만 마지막에 `.toNumber()`(①a Major-2
 * 선례) — 특히 `usable` 의 잔여 판정(승인수량 − 소진수량 > 0)이 그 경계다.
 */
export function concessionView(row: ConcessionRow, onDate: string): ConcessionView {
  const approvedQty = new Prisma.Decimal(String(row.approved_qty));
  const consumedQty = new Prisma.Decimal(String(row.consumed_qty));
  // `@db.Date` — 문자열로 접어 비교한다(타임존 변환이 끼어들 자리가 없다 · CLAUDE.md).
  const validFrom = row.valid_from.toISOString().slice(0, 10);
  const validTo = row.valid_to === null ? null : row.valid_to.toISOString().slice(0, 10);

  return omitEmpty({
    concessionId: Number(row.concession_id),
    concessionNo: row.concession_no,
    nonconformanceId: Number(row.nonconformance_id),
    nonconformanceNo: row.nonconformance_no ?? undefined,
    lotId: Number(row.lot_id),
    lotNo: row.lot_no ?? undefined,
    approvedQty: approvedQty.toNumber(),
    consumedQty: consumedQty.toNumber(),
    uomId: Number(row.uom_id),
    validFrom,
    validTo: validTo ?? undefined,
    allowedWorkOrderId: row.allowed_work_order_id === null ? undefined : Number(row.allowed_work_order_id),
    allowedProcessId: row.allowed_process_id === null ? undefined : Number(row.allowed_process_id),
    allowedCustomerId: row.allowed_customer_id === null ? undefined : Number(row.allowed_customer_id),
    unrestrictedAxes: unrestrictedAxesOf(row),
    approvalRequestId: Number(row.approval_request_id),
    statusCode: row.status_code,
    usable: usableOf(row.status_code, validFrom, validTo, approvedQty, consumedQty, onDate),
    remarks: row.remarks ?? undefined,
  });
}

/** 통보 089 §3 — 계약 프로퍼티 이름 3값을 그대로 쓴다(표시 문구는 화면이 갖는다). */
function unrestrictedAxesOf(row: Pick<ConcessionRow, 'allowed_work_order_id' | 'allowed_process_id' | 'allowed_customer_id'>): string[] {
  const axes: string[] = [];
  if (row.allowed_work_order_id === null) axes.push('allowedWorkOrderId');
  if (row.allowed_process_id === null) axes.push('allowedProcessId');
  if (row.allowed_customer_id === null) axes.push('allowedCustomerId');
  return axes;
}

/**
 * §4-3(통보 089 §2) — 계약은 「상태·유효기간·잔여의 3항 논리곱」인데 서버는 4항째
 * (`valid_from <= 기준일`)를 더했다(⚠ 알려둘 것 — 3항이 정본이면 그 줄을 뺀다). 기간 경계는
 * `@db.Date` 를 문자열로 접어 비교한다(타임존 캐스팅 금지). 잔여는 `Prisma.Decimal` 로 뺀다
 * (부동소수 경계 오사고 방지 · ①a Major-2).
 */
function usableOf(statusCode: string, validFrom: string, validTo: string | null, approvedQty: Prisma.Decimal, consumedQty: Prisma.Decimal, onDate: string): boolean {
  if (statusCode !== APPROVED) return false;
  if (validFrom > onDate) return false;
  if (validTo !== null && validTo < onDate) return false;
  return approvedQty.minus(consumedQty).greaterThan(0);
}

/**
 * ⭐⭐ §2 계열(`assertFollowUpInvariant` 선례) — SQL 의 `usableOnly` WHERE 와 이 파일의
 * `usableOf()` 가 같은 판정을 «두 곳»에 낸다. 같은 페이지 안 «반환된» 모든 행에서 `usable` 이
 * 거짓이면 던진다. ⛔ **단방향이다** — SQL 이 과잉 배제(있어야 할 행이 안 왔다)한 경우는 못
 * 잡는다(대조가 반환된 행만 본다).
 */
export function assertUsableInvariant(usableOnly: boolean | undefined, rows: readonly { concessionId: number; usable: boolean }[]): void {
  if (usableOnly !== true) return;
  for (const row of rows) {
    if (!row.usable) {
      throw new Error(`concessions #${row.concessionId}: usableOnly 불변식 위반 — SQL 은 통과시켰는데 usable=false 다`);
    }
  }
}
