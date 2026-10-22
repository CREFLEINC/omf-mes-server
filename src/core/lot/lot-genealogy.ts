import { WORK_ORDER_LOT_SOURCE } from './lot-source';
import type { Tx } from './lot-registry.service';

/**
 * 투입 자재 LOT → 생산 LOT 계보(omf-all-around#166 · 장부 P-103 · 문의 052 결정 변경 2026-10-22).
 * 현장 스캔 없이 «투입 시각»으로 잇는다 — 같은 W/O·같은 자재에서 다른 LOT 이 투입되기 전까지 만든
 * 제품에 그 LOT 이 들어갔다고 본다(선입선출 가정). 그래서 정확도는 언제나 「추정」이다.
 */
export const CONSUMED_RELATION = 'CONSUMED';
export const INPUT_TIME_WINDOW = 'INPUT_TIME_WINDOW';
export const ESTIMATED_ACCURACY = 'ESTIMATED';
export const PRODUCTION_RESULT_EVENT = 'PRODUCTION_RESULT';

export interface InputRow {
  material_consumption_id: bigint;
  item_id: bigint;
  lot_id: bigint;
  occurred_at: Date;
  corrects_consumption_id: bigint | null;
}

/** 한 자재 LOT 이 쓰였다고 보는 구간 — [from, to). `to` 가 없으면 아직 쓰는 중이다. */
export interface InputWindow {
  itemId: bigint;
  lotId: bigint;
  from: Date;
  to: Date | null;
}

export const INPUT_ROW_SELECT = {
  material_consumption_id: true,
  item_id: true,
  lot_id: true,
  occurred_at: true,
  corrects_consumption_id: true,
} as const;

/**
 * 자재 품목마다 투입을 시각순으로 놓고, «다른» LOT 이 들어온 시각에 앞 LOT 을 끊는다. 같은 LOT 을 다시
 * 넣으면 구간이 이어진다. 정정된 원 투입은 뺀다. 같은 품목이 BOM 여러 줄이어도 투입은 품목 하나로 묶인다
 * (투입이 `bom_component_id` 를 첫 줄로 고정한다).
 */
export function inputWindows(rows: readonly InputRow[]): InputWindow[] {
  const corrected = new Set(rows.flatMap((row) => (row.corrects_consumption_id === null ? [] : [row.corrects_consumption_id])));
  const sorted = rows
    .filter((row) => !corrected.has(row.material_consumption_id))
    .sort(
      (a, b) =>
        a.occurred_at.getTime() - b.occurred_at.getTime() ||
        Number(a.material_consumption_id - b.material_consumption_id),
    );
  const open = new Map<bigint, InputWindow>();
  const windows: InputWindow[] = [];
  for (const row of sorted) {
    const current = open.get(row.item_id);
    if (current?.lotId === row.lot_id) continue;
    if (current !== undefined) current.to = row.occurred_at;
    const next: InputWindow = { itemId: row.item_id, lotId: row.lot_id, from: row.occurred_at, to: null };
    open.set(row.item_id, next);
    windows.push(next);
  }
  return windows;
}

/** 실적 구간 (after, until] 과 겹치는 자재 LOT — 구간 안에서 LOT 이 바뀌었으면 둘 다다. */
export function lotsBetween(windows: readonly InputWindow[], after: Date | null, until: Date): InputWindow[] {
  return windows.filter(
    (w) => w.from <= until && (w.to === null || after === null || w.to > after),
  );
}

/** 한 시점(시리얼의 생산 시각)에 쓰던 자재 LOT — 정확히 교체 시각이면 앞뒤 둘 다다. */
export function lotsAt(windows: readonly InputWindow[], at: Date): InputWindow[] {
  return windows.filter((w) => w.from <= at && (w.to === null || w.to >= at));
}

/** 시리얼이 만들어진 시각 — 생산 시각을 안 받았으면 발번 시각이다. */
export const madeAt = (serial: { produced_at: Date | null; created_at: Date }): Date => serial.produced_at ?? serial.created_at;

/**
 * 계보가 한 줄이라도 있는 W/O — 없으면 #166 배포 전 실적이라 읽는 쪽이 W/O 단위로 물러난다
 * (소급하지 않는다 · 헤더 결정 2026-10-22).
 */
export async function tracedWorkOrders(db: Pick<Tx, 'lot_relation'>, workOrderIds: readonly bigint[]): Promise<Set<bigint>> {
  if (workOrderIds.length === 0) return new Set();
  const rows = await db.lot_relation.findMany({
    where: {
      relation_type_code: CONSUMED_RELATION,
      lot_lot_relation_target_lot_idTolot: { source_type_code: WORK_ORDER_LOT_SOURCE, source_id: { in: [...workOrderIds] } },
    },
    distinct: ['target_lot_id'],
    select: { lot_lot_relation_target_lot_idTolot: { select: { source_id: true } } },
  });
  return new Set(rows.map((row) => row.lot_lot_relation_target_lot_idTolot.source_id));
}

/**
 * 실적 한 건의 계보를 남긴다 — 실적 등록과 같은 트랜잭션이다. 실적 구간은 같은 W/O 의 직전 원 실적
 * 시각부터 이 실적 시각까지다(정정 실적은 경계가 아니다). 배분한 생산 LOT 마다 겹친 자재 LOT 을 잇는다.
 * ⭐ 추가만 한다 — 같은 실적으로 다시 불러도 `uq_lot_relation` 이 겹친 줄을 건너뛴다(지연 입력 투입이 부른다).
 */
export async function recordResultGenealogyWithin(
  tx: Tx,
  productionResultId: bigint,
  createdBy: number | undefined,
): Promise<number> {
  const result = await tx.production_result.findUniqueOrThrow({
    where: { production_result_id: productionResultId },
    select: {
      work_order_id: true,
      occurred_at: true,
      production_result_lot_allocation: { select: { lot_id: true, allocated_qty: true, uom_id: true } },
    },
  });
  if (result.production_result_lot_allocation.length === 0) return 0;
  const [previous, inputs] = await Promise.all([
    tx.production_result.findFirst({
      where: {
        work_order_id: result.work_order_id,
        corrects_production_result_id: null,
        occurred_at: { lt: result.occurred_at },
        production_result_id: { not: productionResultId },
      },
      orderBy: { occurred_at: 'desc' },
      select: { occurred_at: true },
    }),
    tx.material_consumption.findMany({ where: { work_order_id: result.work_order_id }, select: INPUT_ROW_SELECT }),
  ]);
  const materials = lotsBetween(inputWindows(inputs), previous?.occurred_at ?? null, result.occurred_at);
  const data = result.production_result_lot_allocation.flatMap((allocation) =>
    [...new Set(materials.map((m) => m.lotId))]
      .filter((lotId) => lotId !== allocation.lot_id)
      .map((lotId) => ({
        source_lot_id: lotId,
        target_lot_id: allocation.lot_id,
        relation_type_code: CONSUMED_RELATION,
        // 자재 수량이 아니라 «이 LOT 이 관여한 생산 수량»이다 — BOM 환산은 기준 수량 해석이 추측이 된다.
        relation_qty: allocation.allocated_qty,
        uom_id: allocation.uom_id,
        source_event_type_code: PRODUCTION_RESULT_EVENT,
        source_event_id: productionResultId,
        allocation_method_code: INPUT_TIME_WINDOW,
        trace_accuracy_code: ESTIMATED_ACCURACY,
        occurred_at: result.occurred_at,
        created_by: createdBy,
      })),
  );
  if (data.length === 0) return 0;
  const created = await tx.lot_relation.createMany({ data, skipDuplicates: true });
  return created.count;
}

/**
 * 지연 입력 투입 — 이미 등록된 실적보다 이른 시각이면 그 시각 이후 원 실적의 계보를 다시 «더한다».
 * 앞 LOT 의 구간이 짧아져도 이미 남긴 줄은 지우지 않는다(넓게 잡는 쪽이 회수에 안전하다).
 */
export async function recordLateInputGenealogyWithin(
  tx: Tx,
  workOrderId: bigint,
  occurredAt: Date,
  createdBy: number | undefined,
): Promise<void> {
  const results = await tx.production_result.findMany({
    where: {
      work_order_id: workOrderId,
      corrects_production_result_id: null,
      occurred_at: { gte: occurredAt },
      production_result_lot_allocation: { some: {} },
    },
    select: { production_result_id: true },
    orderBy: { production_result_id: 'asc' },
  });
  for (const { production_result_id } of results) {
    await recordResultGenealogyWithin(tx, production_result_id, createdBy);
  }
}
