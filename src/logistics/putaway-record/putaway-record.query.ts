import { Prisma } from '@prisma/client';

import { localPeriodSql } from '../../common/period/plant-local-period';
import { PrismaService } from '../../prisma/prisma.service';

export type RecordScope = 'WORKER' | 'TERMINAL';

/** 적치 기록 한 줄 — 지시 없는 적치(DIRECT, 입고 라인)와 지시 적치(TASK, 완료된 적치 지시)를 같은 모양으로 읽는다. */
export interface RecordRow {
  record_type: 'DIRECT' | 'TASK'; record_id: bigint; recorded_at: Date;
  /** DIRECT 는 라인 적치 방식, TASK 는 지시 상태(COMPLETED · COMPLETED_TEMPORARY). */
  mode_code: string;
  receipt_type_code: string | null; replenishment: boolean;
  /** 반납 입고 줄에서 생긴 지시(피처 019) — 적치 지시 쪽만 싣는다. */
  material_return?: boolean; document_no: string;
  lot_id: bigint; lot_no: string; item_id: bigint; item_code: string; item_name: string;
  qty: Prisma.Decimal; uom_code: string; quality_status_code: string | null;
  warehouse_id: bigint; warehouse_code: string; warehouse_name: string; location_id: bigint; location_code: string;
  worker_no: string; worker_name: string; terminal_code: string; receipt_status_code: string | null;
}

export interface PutawayRecordView {
  recordType: 'DIRECT' | 'TASK'; recordId: number; putawayModeCode: string; sourceCode: 'PURCHASE' | 'PRODUCT' | 'REPLENISHMENT' | 'MATERIAL_RETURN';
  recordedAt: string; documentNo: string; lot: { lotId: number; lotNo: string };
  item: { itemId: number; itemCode: string; itemName: string }; qty: string; uomCode: string; qualityStatusCode: string | null;
  warehouse: { warehouseId: number; warehouseCode: string; warehouseName: string };
  location: { locationId: number; locationCode: string; path: string };
  worker: { workerNo: string; workerName: string }; terminalCode: string; receiptStatusCode: string | null;
}

export interface RecordFilter { plantId: bigint; timezone: string; businessDate: string; scope: RecordScope; actorId: bigint }

/** 칸 이름은 묶지 못한다 — 기준마다 정해 둔 칸만 쓴다(부분 색인 넷과 같은 칸). */
const ACTOR_COLUMN: Record<RecordScope, { receipt: string; task: string }> = {
  WORKER: { receipt: 'r.putaway_worker_id', task: 't.completed_worker_id' },
  TERMINAL: { receipt: 'r.putaway_terminal_id', task: 't.completed_terminal_id' },
};

const COMMON_COLUMNS = `
  lo.lot_id, lo.lot_no, i.item_id, i.item_code, i.item_name, u.uom_code,
  w.warehouse_id, w.warehouse_code, w.warehouse_name, loc.location_id, loc.location_code,
  wk.worker_no, wk.worker_name, tm.terminal_code`;

/** 그날(공장 현지 날짜) 그 작업자·단말의 적치 전부 — 하루치라 두 출처를 다 읽고 합친다(작업자 하루 수십~수백 건). */
export async function loadPutawayRecords(prisma: PrismaService, filter: RecordFilter): Promise<RecordRow[]> {
  const actor = ACTOR_COLUMN[filter.scope];
  // 두 문장이 같은 자리표를 쓴다 — 1 공장 · 2 작업자/단말 · 3 시간대 · 4 날짜.
  const params: unknown[] = [filter.plantId, filter.actorId, filter.timezone, filter.businessDate];
  const period = { from: filter.businessDate, to: filter.businessDate };
  const bind = (): string => '$4::text';
  const directPeriod = localPeriodSql('r.receipt_datetime', '$3::text', period, bind);
  const taskPeriod = localPeriodSql('t.completed_at', '$3::text', period, bind);

  const direct = prisma.$queryRawUnsafe<RecordRow[]>(`
    SELECT 'DIRECT' AS record_type, l.goods_receipt_line_id AS record_id, r.receipt_datetime AS recorded_at, l.putaway_mode_code AS mode_code,
           r.receipt_type_code, false AS replenishment, r.goods_receipt_no AS document_no, l.receipt_qty AS qty,
           l.quality_status_code, r.status_code AS receipt_status_code, ${COMMON_COLUMNS}
      FROM logistics.goods_receipt r
      JOIN logistics.goods_receipt_line l ON l.goods_receipt_id = r.goods_receipt_id AND l.putaway_mode_code IS NOT NULL
      JOIN trace.lot lo ON lo.lot_id = l.lot_id
      JOIN mdm.item i ON i.item_id = l.item_id
      JOIN mdm.uom u ON u.uom_id = l.uom_id
      JOIN mdm.location loc ON loc.location_id = l.destination_location_id
      JOIN mdm.warehouse w ON w.warehouse_id = loc.warehouse_id
      JOIN mdm.worker wk ON wk.worker_id = r.putaway_worker_id
      JOIN mdm.terminal tm ON tm.terminal_id = r.putaway_terminal_id
     WHERE ${actor.receipt} = $2::bigint AND r.plant_id = $1::bigint AND ${directPeriod}`, ...params);
  // 수량·품질은 지시가 남긴 원장 줄 — 보충 수령 원천은 남은 만큼만 옮긴다(옮긴 것이 없으면 원장 줄이 없다).
  const task = prisma.$queryRawUnsafe<RecordRow[]>(`
    SELECT 'TASK' AS record_type, t.putaway_task_id AS record_id, t.completed_at AS recorded_at, t.status_code AS mode_code,
           gr.receipt_type_code, t.shopfloor_receipt_line_id IS NOT NULL AS replenishment,
           t.material_return_line_id IS NOT NULL AS material_return, t.putaway_task_no AS document_no,
           COALESCE(il.qty, t.task_qty) AS qty, COALESCE(il.to_quality_status_code, gl.quality_status_code) AS quality_status_code,
           gr.status_code AS receipt_status_code, ${COMMON_COLUMNS}
      FROM logistics.putaway_task t
      JOIN mdm.location loc ON loc.location_id = t.actual_location_id
      JOIN mdm.warehouse w ON w.warehouse_id = loc.warehouse_id
      JOIN trace.lot lo ON lo.lot_id = t.lot_id
      JOIN mdm.item i ON i.item_id = t.item_id
      JOIN mdm.uom u ON u.uom_id = t.uom_id
      JOIN mdm.worker wk ON wk.worker_id = t.completed_worker_id
      JOIN mdm.terminal tm ON tm.terminal_id = t.completed_terminal_id
      LEFT JOIN logistics.goods_receipt_line gl ON gl.goods_receipt_line_id = t.goods_receipt_line_id
      LEFT JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = gl.goods_receipt_id
      LEFT JOIN inventory.inventory_transaction_line il ON il.inventory_transaction_line_id = t.inventory_transaction_line_id
     WHERE ${actor.task} = $2::bigint AND w.plant_id = $1::bigint
       AND t.status_code IN ('COMPLETED', 'COMPLETED_TEMPORARY') AND ${taskPeriod}`, ...params);
  const [directRows, taskRows] = await Promise.all([direct, task]);
  return mergeRecords(directRows, taskRows);
}

/** 최근 순 — 같은 시각이면 TASK 먼저, 그다음 id 내림차순(쪽을 넘겨도 순서가 흔들리지 않게). */
export function mergeRecords(direct: readonly RecordRow[], task: readonly RecordRow[]): RecordRow[] {
  return [...direct, ...task].sort((a, b) =>
    b.recorded_at.getTime() - a.recorded_at.getTime()
    || b.record_type.localeCompare(a.record_type)
    || (b.record_id > a.record_id ? 1 : b.record_id < a.record_id ? -1 : 0));
}

export function recordView(row: RecordRow, path: string): PutawayRecordView {
  return {
    recordType: row.record_type, recordId: Number(row.record_id), putawayModeCode: modeOf(row), sourceCode: sourceOf(row),
    recordedAt: row.recorded_at.toISOString(), documentNo: row.document_no,
    lot: { lotId: Number(row.lot_id), lotNo: row.lot_no },
    item: { itemId: Number(row.item_id), itemCode: row.item_code, itemName: row.item_name },
    qty: new Prisma.Decimal(row.qty).toString(), uomCode: row.uom_code, qualityStatusCode: row.quality_status_code,
    warehouse: { warehouseId: Number(row.warehouse_id), warehouseCode: row.warehouse_code, warehouseName: row.warehouse_name },
    location: { locationId: Number(row.location_id), locationCode: row.location_code, path },
    worker: { workerNo: row.worker_no, workerName: row.worker_name }, terminalCode: row.terminal_code,
    receiptStatusCode: row.receipt_status_code,
  };
}

function modeOf(row: RecordRow): string {
  if (row.record_type === 'DIRECT') return row.mode_code;
  return row.mode_code === 'COMPLETED_TEMPORARY' ? 'TASK_TEMPORARY' : 'TASK';
}

/** 입고에서 온 지시는 입고 종류로(제품 입고만 PRODUCT), 보충 수령 원천(피처 004)은 REPLENISHMENT, 반납 입고 원천(피처 019)은 MATERIAL_RETURN. */
function sourceOf(row: RecordRow): PutawayRecordView['sourceCode'] {
  if (row.replenishment) return 'REPLENISHMENT';
  if (row.material_return === true) return 'MATERIAL_RETURN';
  return row.receipt_type_code === 'PRODUCT' ? 'PRODUCT' : 'PURCHASE';
}
