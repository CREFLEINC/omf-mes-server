import { Prisma } from '@prisma/client';

/**
 * 출하 내역(W-04-12 · 피처 010 US7)의 계산 칸 — ERP 송신 상태·취소 상신 중·완료 단말·작업자·재고가 빠진 창고들.
 * ⭐ ERP 송신 상태는 SQL 한 벌이다 — 목록 필터(`erpSendStatus=`)와 응답 칸이 같은 CASE 를 쓴다(두 벌이면 갈린다).
 */
export type ErpSendStatus = 'NOT_QUEUED' | 'NOT_SENT_NO_SALES_ORDER' | 'CANCELLED' | 'SEND_ERROR' | 'PENDING' | 'SENT';

export const ERP_SEND_STATUSES: readonly ErpSendStatus[] = ['NOT_QUEUED', 'NOT_SENT_NO_SALES_ORDER', 'CANCELLED', 'SEND_ERROR', 'PENDING', 'SENT'];

/** 그 출하의 마지막 PGI 메시지 한 칸(바깥 별칭 `s`). */
const message = (column: string): string => `(SELECT m.${column} FROM integration.integration_message m
         WHERE m.interface_code = 'IF-SHIPMENT-PGI-SEND' AND m.target_type_code = 'SHIPMENT' AND m.target_id = s.shipment_id
         ORDER BY m.integration_message_id DESC LIMIT 1)`;

/**
 * 위에서부터 처음 맞는 값(data-model 「ERP 송신 상태」): 확정 전(옛 흐름 미확정) → 수주 연결 라인 0 → 메시지 없음(확정 전 취소) →
 * 메시지 취소 → 송신 오류 → 대기(보내기 전 — PENDING · `sent_at` 없음 · 바깥 행 0) → 그 밖(PROCESSING·DONE) 보냄.
 */
export const ERP_SEND_STATUS_SQL = `CASE
      WHEN s.status_code = 'UNCONFIRMED' THEN 'NOT_QUEUED'
      WHEN NOT EXISTS (SELECT 1 FROM logistics.shipment_line sl
                         JOIN logistics.shipment_request_line rl ON rl.shipment_request_line_id = sl.shipment_request_line_id
                        WHERE sl.shipment_id = s.shipment_id AND rl.sales_order_line_id IS NOT NULL) THEN 'NOT_SENT_NO_SALES_ORDER'
      WHEN ${message('status_code')} IS NULL THEN 'NOT_QUEUED'
      WHEN ${message('status_code')} = 'CANCELLED' THEN 'CANCELLED'
      WHEN ${message('status_code')} = 'FAILED' THEN 'SEND_ERROR'
      WHEN ${message('status_code')} = 'PENDING' AND ${message('sent_at')} IS NULL
       AND NOT EXISTS (SELECT 1 FROM integration.erp_outbound_row o WHERE o.integration_message_id = ${message('integration_message_id')})
        THEN 'PENDING'
      ELSE 'SENT'
    END`;

/** 열린 취소 결재(상신 중) — 확정과 송신을 막는다(J-7 · FR-024). */
export const CANCEL_REQUEST_PENDING_SQL = `EXISTS (SELECT 1 FROM app.approval_request a
                 WHERE a.target_type_code = 'SHIPMENT' AND a.target_id = s.shipment_id
                   AND a.approval_type_code = 'SHIPMENT_CANCEL' AND a.status_code = 'PENDING')`;

export interface ShipmentHistoryFacts {
  erpSendStatus: ErpSendStatus;
  cancelRequestPending: boolean;
  completedTerminal: { terminalId: number; terminalCode: string } | null;
  completedWorker: { workerId: number; workerNo: string; workerName: string } | null;
  warehouses: { warehouseId: number; warehouseCode: string; warehouseName: string }[];
}

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** 출하 id 들 → 계산 칸. 한 질의로 끝낸다(창고는 내부 재고 차감 기록 `goods_issue` 기준 — 옛 흐름은 출하 창고 하나). */
export async function shipmentHistoryFacts(db: Db, ids: readonly bigint[]): Promise<Map<string, ShipmentHistoryFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{
    shipment_id: bigint; erp_send_status: ErpSendStatus; cancel_request_pending: boolean;
    terminal_id: bigint | null; terminal_code: string | null; worker_id: bigint | null; worker_no: string | null; worker_name: string | null;
    warehouses: { warehouseId: number; warehouseCode: string; warehouseName: string }[] | null;
  }[]>(Prisma.sql`
    SELECT s.shipment_id,
           ${Prisma.raw(ERP_SEND_STATUS_SQL)} AS erp_send_status,
           ${Prisma.raw(CANCEL_REQUEST_PENDING_SQL)} AS cancel_request_pending,
           t.terminal_id, t.terminal_code, w.worker_id, w.worker_no, w.worker_name,
           (SELECT json_agg(json_build_object('warehouseId', x.warehouse_id, 'warehouseCode', x.warehouse_code, 'warehouseName', x.warehouse_name)
                            ORDER BY x.warehouse_id)
              FROM mdm.warehouse x
             WHERE x.warehouse_id = s.warehouse_id
                OR x.warehouse_id IN (SELECT gi.source_warehouse_id FROM logistics.goods_issue gi
                                       WHERE gi.source_document_type_code = 'SHIPMENT' AND gi.source_document_id = s.shipment_id)) AS warehouses
      FROM logistics.shipment s
      LEFT JOIN mdm.terminal t ON t.terminal_id = s.completed_terminal_id
      LEFT JOIN mdm.worker w ON w.worker_id = s.completed_worker_id
     WHERE s.shipment_id IN (${Prisma.join([...ids])})`);
  return new Map(rows.map((row) => [String(row.shipment_id), {
    erpSendStatus: row.erp_send_status,
    cancelRequestPending: row.cancel_request_pending,
    completedTerminal: row.terminal_id === null ? null : { terminalId: Number(row.terminal_id), terminalCode: row.terminal_code ?? '' },
    completedWorker: row.worker_id === null ? null : { workerId: Number(row.worker_id), workerNo: row.worker_no ?? '', workerName: row.worker_name ?? '' },
    warehouses: (row.warehouses ?? []).map((warehouse) => ({ ...warehouse, warehouseId: Number(warehouse.warehouseId) })),
  }]));
}
