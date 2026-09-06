import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// 유형↔표 매핑을 코드에 둔다 — entity_type_registry 는 칸이 넷뿐이라 DocumentProgress 를 못 채우고,
// 식별자를 SQL 로 흘리지 않는다. 등록부는 부팅 대조에만 쓴다(plan-integration §9 #5 · I-5.md §4-5).

/** 조회 축 9종 — `CD-LOGISTICS-DOCUMENT-TYPE`. 취소 실행 축은 이 중 `cancelable` 셋이다. */
export type LogisticsDocumentType =
  | 'PURCHASE_ORDER' | 'INBOUND_RECEIPT' | 'GOODS_RECEIPT' | 'MATERIAL_ISSUE_REQUEST' | 'PICKING_ORDER'
  | 'STOCK_TRANSFER' | 'SUBCONTRACT_ISSUE' | 'SUBCONTRACT_RECEIPT' | 'GOODS_ISSUE';

export interface DocumentTypeMapping {
  entityTypeCode: string;
  /** Prisma delegate 이름 = 물리 표 이름. 유형별 쿼리는 이 이름의 delegate 를 «명시적으로» 부른다. */
  delegate: string;
  idColumn: string;
  /** 외주 2종은 문서번호·라인·수량 칸이 없다 — FK 로 이어진 출고·입고에서 판다(I-5.md §5-2). */
  noColumn: string | null;
  /** 자재출고요청·피킹지시는 문서 일자 칸이 없다(`required_at` 은 요청 기한이다 · §1-4 ⓐ). */
  dateColumn: string | null;
  lineDelegate: string | null;
  plannedColumn: string | null;
  processedColumn: string | null;
  subTypeColumn: string | null;
  cancelable: boolean;
  /**
   * 후속 세기 규칙 ②(취소된 후속은 안 센다)를 적용할 유형만 값을 든다. 나머지는 상태 값 목록이
   * 없어 `'CANCELLED'` 를 지어 넣지 않는다 — 원장·투입은 규칙 ③이 대신한다(I-5.md R-6 ⓑ · F-6).
   */
  cancelledStatus: 'CANCELLED' | null;
}

/** 9종 모두 `logistics` 스키마다 — 부팅 대조의 `schema_name` 쪽. */
export const DOCUMENT_SCHEMA = 'logistics';

export const DOCUMENT_TYPES: Record<LogisticsDocumentType, DocumentTypeMapping> = {
  PURCHASE_ORDER: { entityTypeCode: 'PURCHASE_ORDER', delegate: 'purchase_order', idColumn: 'purchase_order_id',
    noColumn: 'purchase_order_no', dateColumn: 'order_date', lineDelegate: 'purchase_order_line',
    plannedColumn: 'ordered_qty', processedColumn: 'received_qty', subTypeColumn: null, cancelable: false, cancelledStatus: null },
  INBOUND_RECEIPT: { entityTypeCode: 'INBOUND_RECEIPT', delegate: 'inbound_receipt', idColumn: 'inbound_receipt_id',
    noColumn: 'inbound_receipt_no', dateColumn: 'receipt_datetime', lineDelegate: 'inbound_receipt_line',
    plannedColumn: null, processedColumn: 'received_qty', subTypeColumn: null, cancelable: true, cancelledStatus: null },
  GOODS_RECEIPT: { entityTypeCode: 'GOODS_RECEIPT', delegate: 'goods_receipt', idColumn: 'goods_receipt_id',
    noColumn: 'goods_receipt_no', dateColumn: 'receipt_datetime', lineDelegate: 'goods_receipt_line',
    plannedColumn: 'expected_qty', processedColumn: 'receipt_qty', subTypeColumn: 'receipt_type_code', cancelable: true, cancelledStatus: 'CANCELLED' },
  MATERIAL_ISSUE_REQUEST: { entityTypeCode: 'MATERIAL_ISSUE_REQUEST', delegate: 'material_issue_request', idColumn: 'material_issue_request_id',
    noColumn: 'issue_request_no', dateColumn: null, lineDelegate: 'material_issue_request_line',
    plannedColumn: 'requested_qty', processedColumn: 'issued_qty', subTypeColumn: null, cancelable: false, cancelledStatus: null },
  PICKING_ORDER: { entityTypeCode: 'PICKING_ORDER', delegate: 'picking_order', idColumn: 'picking_order_id',
    noColumn: 'picking_order_no', dateColumn: null, lineDelegate: 'picking_line',
    plannedColumn: 'planned_qty', processedColumn: 'picked_qty', subTypeColumn: null, cancelable: false, cancelledStatus: null },
  STOCK_TRANSFER: { entityTypeCode: 'STOCK_TRANSFER', delegate: 'stock_transfer', idColumn: 'stock_transfer_id',
    noColumn: 'stock_transfer_no', dateColumn: 'requested_at', lineDelegate: 'stock_transfer_line',
    plannedColumn: 'requested_qty', processedColumn: 'received_qty', subTypeColumn: null, cancelable: false, cancelledStatus: null },
  SUBCONTRACT_ISSUE: { entityTypeCode: 'SUBCONTRACT_ISSUE', delegate: 'subcontract_issue', idColumn: 'subcontract_issue_id',
    noColumn: null, dateColumn: 'issued_at', lineDelegate: null,
    plannedColumn: null, processedColumn: null, subTypeColumn: null, cancelable: false, cancelledStatus: null },
  SUBCONTRACT_RECEIPT: { entityTypeCode: 'SUBCONTRACT_RECEIPT', delegate: 'subcontract_receipt', idColumn: 'subcontract_receipt_id',
    noColumn: null, dateColumn: 'received_at', lineDelegate: null,
    plannedColumn: null, processedColumn: null, subTypeColumn: null, cancelable: false, cancelledStatus: null },
  GOODS_ISSUE: { entityTypeCode: 'GOODS_ISSUE', delegate: 'goods_issue', idColumn: 'goods_issue_id',
    noColumn: 'goods_issue_no', dateColumn: 'issued_at', lineDelegate: 'goods_issue_line',
    plannedColumn: null, processedColumn: 'issue_qty', subTypeColumn: 'issue_type_code', cancelable: true, cancelledStatus: 'CANCELLED' },
};

/**
 * 부팅 시 1회 대조 — 9종의 `(schema_name, table_name)` 이 등록부에 있는가. 어긋나면 «경고만» 하고
 * 던지지 않는다: 등록부가 비어도 서비스는 떠야 하고 매핑의 정본은 위 표다. 「유형이 늘 때 조용히
 * 틀리는 것」을 이 대조가 잡는다(plan-integration §9 #5).
 *
 * ⚠ 후속 축의 `INVENTORY_TRANSACTION` 은 PK 가 `(id, business_date)` 복합이라 등록부의
 *   `id_column_name` 한 칸과 안 맞는다 — 대조에만 쓰므로 그대로 둔다(I-5.md R-6).
 */
@Injectable()
export class DocumentTypeRegistryChecker implements OnModuleInit {
  private readonly logger = new Logger(DocumentTypeRegistryChecker.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const registered = await this.prisma.entity_type_registry.findMany({
      where: { schema_name: DOCUMENT_SCHEMA },
      select: { table_name: true },
    });
    const known = new Set(registered.map((r) => r.table_name));
    const missing = Object.values(DOCUMENT_TYPES)
      .filter((m) => !known.has(m.delegate))
      .map((m) => m.entityTypeCode);
    if (missing.length > 0) {
      this.logger.warn(`entity_type_registry 에 없는 물류 문서 유형: ${missing.join(', ')}`);
    }
  }
}
