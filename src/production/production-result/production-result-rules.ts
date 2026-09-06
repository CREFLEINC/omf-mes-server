import { ERROR_CODE, field, one } from '../../common/errors';

export interface ResultLotAllocation {
  lotId: number;
  allocatedQty: number;
}

/** required 넷. ⛔ `shiftId`·`workerId`·`businessDate` 칸이 계약에 없다(§1-3). */
export interface ProductionResultCreate {
  workOrderId: number;
  workSessionId?: number;
  goodQty?: number;
  defectQty?: number;
  holdQty?: number;
  scrapQty?: number;
  reworkQty?: number;
  uomId: number;
  resultSourceCode: string;
  occurredAt: string;
  lateEntryReasonCode?: string;
  equipmentId?: number;
  moldId?: number;
  lotAllocations?: ResultLotAllocation[];
  remarks?: string;
}

const QTY_COLUMNS = {
  goodQty: 'good_qty',
  defectQty: 'defect_qty',
  holdQty: 'hold_qty',
  scrapQty: 'scrap_qty',
  reworkQty: 'rework_qty',
} as const;

const VOIDED = 'VOIDED';
/** 실적을 받지 않는 W/O 상태 — 선발행 슬롯이 «없는» 두 끝이다(§3-2). */
const NO_SLOT_STATUS: readonly string[] = ['PLANNED', 'CONFIRMED', 'CANCELLED'];

/**
 * 다섯 수량 손검사 + 물리 칸으로. ⛔ `app.qty_t CHECK (>= 0)`·`ck_production_result_nonzero` 를
 * «앞당겨» 막는다 — CHECK 위반은 `PrismaClientUnknownRequestError` 라 공용 그물에 안 걸려 500 이
 * 샌다. 생략한 칸은 **0**(`P-02-04` §4).
 */
export function resultQuantities(body: ProductionResultCreate): Record<string, number> {
  const columns: Record<string, number> = {};
  let sum = 0;
  for (const [name, column] of Object.entries(QTY_COLUMNS)) {
    const value = body[name as keyof typeof QTY_COLUMNS] ?? 0;
    if (value < 0) throw one(field(name, ERROR_CODE.INVALID, '0보다 작을 수 없습니다.'));
    columns[column] = value;
    sum += value;
  }
  if (sum === 0) {
    throw one(field('goodQty', ERROR_CODE.INVALID, '다섯 수량의 합이 0일 수 없습니다.'));
  }
  return columns;
}

/**
 * 요청 «안»의 오류 + 합계 상한. 이 W/O 의 슬롯인지는 잠근 뒤 `assertSlots` 가 본다.
 * ⚠ 상한은 I-7.md §4-5 가 ⌜대조하지 않는다⌝ 로 적었으나 **물리가 이미 막고 있다** —
 * `trg_result_lot_allocation_sum`(DB-C18 · baseline:2893)이 지연 트리거라 커밋 때 터져 500 이 샌다.
 * ⛔ 「같은가」는 여전히 안 본다 — 물리도 상한만 걸었다(적게 배분하는 것은 정상이다).
 */
export function assertAllocations(allocations: readonly ResultLotAllocation[], goodQty: number): void {
  const seen = new Set<number>();
  let total = 0;
  for (const allocation of allocations) {
    if (allocation.allocatedQty <= 0) {
      throw one(field('lotAllocations', ERROR_CODE.INVALID, '배분 수량은 0보다 커야 합니다.'));
    }
    // ⛔ `UNIQUE_VIOLATION` 이 아니다 — 요청 «안»의 중복은 저장 충돌이 아니라 입력 오류다.
    if (seen.has(allocation.lotId)) {
      throw one(field('lotAllocations', ERROR_CODE.INVALID, '같은 LOT 을 두 번 배분할 수 없습니다.'));
    }
    seen.add(allocation.lotId);
    total += allocation.allocatedQty;
  }
  if (total > goodQty) {
    throw one(field('lotAllocations', ERROR_CODE.INVALID, '배분 합계가 양품수량을 넘을 수 없습니다.'));
  }
}

/**
 * 실적을 받는 W/O 상태(§3-2). 기준은 하나 — 「선발행 슬롯이 서 있는가」(`:release` 가 만들고
 * `:cancel` 이 전건 폐번한다). ⭐ `CLOSED` 는 **허용** — 지연 실적을 덧붙이는 것이 확정된 업무이고
 * (`W-02-05` §5-4 규칙 3) `work_order` 를 UPDATE 하지 않아 마감 불변 트리거(BEFORE UPDATE)에 안
 * 걸린다. ⛔ `transitions.ts` 를 안 탄다 — 전이가 아니라 「받는가」의 잠금이다.
 */
export function assertResultAccepted(statusCode: string): void {
  if (NO_SLOT_STATUS.includes(statusCode)) {
    throw one(field('workOrderId', ERROR_CODE.STATE_LOCKED, '실적을 받을 수 없는 작업지시 상태입니다.'));
  }
}

export interface SlotRow {
  lot_id: bigint;
  lifecycle_status_code: string | null;
}

/** 이 W/O 의 선발행 슬롯인가 · 폐번되지 않았는가(§3-1). ⛔ 폐번을 `moveWithin` 의 `skipped` 로
 * 흘리지 않는다 — 배분 행만 남으면 마감의 슬롯 집계가 되살아난 것처럼 센다. */
export function assertSlots(allocations: readonly ResultLotAllocation[], slots: readonly SlotRow[]): void {
  const byId = new Map(slots.map((slot) => [Number(slot.lot_id), slot]));
  for (const allocation of allocations) {
    const slot = byId.get(allocation.lotId);
    if (slot === undefined) {
      throw one(field('lotAllocations', ERROR_CODE.INVALID, '이 작업지시의 선발행 LOT 이 아닙니다.'));
    }
    if (slot.lifecycle_status_code === VOIDED) {
      throw one(field('lotAllocations', ERROR_CODE.STATE_LOCKED, '폐번된 LOT 에는 배분할 수 없습니다.'));
    }
  }
}
