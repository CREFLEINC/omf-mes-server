import { ERROR_CODE, field, one } from '../../common/errors';
import { assertNotBlank } from '../../common/master';

/** 계약 `ResultLotAllocation` — 두 칸 다 required. */
export interface ResultLotAllocation {
  lotId: number;
  allocatedQty: number;
}

/** 계약 `ProductionResultCreate` 15칸 — required 넷. ⛔ `shiftId`·`workerId`·`businessDate` 칸이 없다. */
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

/** 계약 칸 이름 → 물리 칸. 다섯을 한자리에 들어 검사와 저장이 같은 목록을 본다. */
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
 * 다섯 수량 손검사 + 물리 칸으로 옮기기.
 *
 * ⛔ `app.qty_t CHECK (VALUE >= 0)` 과 `ck_production_result_nonzero` 를 «앞당겨» 막는다 —
 * 도메인 CHECK 위반은 `PrismaClientUnknownRequestError` 라 공용 그물에 안 걸려 500 이 샌다
 * (`prisma-error.ts:23` · `work-order-write.service.ts` 의 같은 판정).
 * 생략한 칸은 **0** 이다 — 화면이 양품만 보내고 나머지 넷은 입력받지 않는다(`P-02-04` §4).
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
 * 배분 — 요청 «안»의 오류만 본다(이 W/O 의 슬롯인지는 잠근 뒤에 본다 · `assertSlots`).
 * ⛔ `Σ allocatedQty` 가 `goodQty` 와 «같은지»는 안 본다 — 상한만 `assertAllocationCap` 이 본다(§4-5).
 */
export function assertAllocations(allocations: readonly ResultLotAllocation[]): void {
  const seen = new Set<number>();
  for (const allocation of allocations) {
    if (allocation.allocatedQty <= 0) {
      throw one(field('lotAllocations', ERROR_CODE.INVALID, '배분 수량은 0보다 커야 합니다.'));
    }
    // ⛔ `UNIQUE_VIOLATION` 이 아니다 — 요청 «안»의 중복은 저장 충돌이 아니라 입력 오류다.
    if (seen.has(allocation.lotId)) {
      throw one(field('lotAllocations', ERROR_CODE.INVALID, '같은 LOT 을 두 번 배분할 수 없습니다.'));
    }
    seen.add(allocation.lotId);
  }
}

/**
 * 배분 합계의 **상한** — `trg_result_lot_allocation_sum`(DB-C18 · `Σ allocated_qty <= good_qty`)을
 * 앞당겨 막는다.
 *
 * ⚠ I-7.md §4-5 는 ⌜`Σ allocatedQty` 를 `goodQty` 와 대조하지 않는다⌝ 로 적었으나 **물리가 이미
 * 막고 있다**(baseline:2893). 그 트리거는 `DEFERRABLE INITIALLY DEFERRED` 라 커밋 시점에 터지고
 * `check_violation` 은 `PrismaClientUnknownRequestError` 로 와 공용 그물에 안 걸려 **500 이 샌다**.
 * ⛔ 「같은가」는 여전히 안 본다 — 물리도 상한만 걸었고(적게 배분하는 것은 정상이다) 계약은
 * 침묵한다. 이 함수는 물리가 이미 세운 선 하나만 옮겨 적는다.
 */
export function assertAllocationCap(allocations: readonly ResultLotAllocation[], goodQty: number): void {
  const total = allocations.reduce((sum, allocation) => sum + allocation.allocatedQty, 0);
  if (total > goodQty) {
    throw one(field('lotAllocations', ERROR_CODE.INVALID, '배분 합계가 양품수량을 넘을 수 없습니다.'));
  }
}

/** 지연 입력 사유는 그룹 값이 **0건**이라 대조를 걸지 않는다 — 걸면 모든 값이 400 이 된다(I-6 §9-1 #2). */
export function assertLateEntryReason(reasonCode: string | undefined): void {
  if (reasonCode === undefined) return;
  assertNotBlank([['lateEntryReasonCode', reasonCode]]);
}

/**
 * 실적을 받는 W/O 상태(§3-2). 기준은 하나 — 「선발행 슬롯이 서 있는가」. 슬롯은 `:release` 가
 * 만들고 `:cancel` 이 전건 폐번한다.
 *
 * ⭐ `CLOSED` 는 **허용**이다 — 마감 뒤 도착한 지연 실적을 덧붙이는 것이 확정된 업무이고
 * (`W-02-05` §5-4 규칙 3), 실적은 `work_order` 를 UPDATE 하지 않아 마감 불변 트리거
 * (`trg_work_order_closed_immutable` — BEFORE **UPDATE**)에 걸리지 않는다.
 * ⛔ `transitions.ts` 를 안 탄다 — 전이가 아니라 「받는가」의 잠금이다.
 */
export function assertResultAccepted(statusCode: string): void {
  if (NO_SLOT_STATUS.includes(statusCode)) {
    throw one(field('workOrderId', ERROR_CODE.STATE_LOCKED, '실적을 받을 수 없는 작업지시 상태입니다.'));
  }
}

/** 잠근 뒤 읽은 선발행 슬롯에서 판정에 쓰는 칸만. */
export interface SlotRow {
  lot_id: bigint;
  lifecycle_status_code: string | null;
}

/**
 * 배분 대상이 **이 W/O 의 선발행 슬롯**인가 · 폐번되지 않았는가(§3-1).
 * ⛔ 폐번 슬롯을 `moveWithin` 의 `skipped` 로 흘리지 않는다 — 배분 행만 남으면 마감의
 * 「실적 붙은 슬롯」 집계가 그 슬롯을 되살아난 것처럼 센다.
 */
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
