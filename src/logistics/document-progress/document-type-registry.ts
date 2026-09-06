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
  noColumn: string | null;
  /** 일자 칸이 없는 둘은 `created_at` 을 쓴다 — 정렬도 그 축이다(I-5.md §5-1·§5-3). */
  dateColumn: string;
  /** 외주 2문서에 번호·라인 칸이 없어 짝 전표에서 판다 — FK 로 이어진 출고·입고다(I-5.md §5-2). */
  derivedFrom: 'goods_issue' | 'goods_receipt' | null;
  lineDelegate: string | null;
  plannedColumn: string | null;
  processedColumn: string | null;
  subTypeColumn: string | null;
  cancelable: boolean;
  /**
   * PR ④ 추가 — If-Match 토큰을 대조할 칸. 계약이 「토큰은 대상 문서 리소스의 상세 GET 이
   * 내려주는 ETag」로 못박아(I-5.md §7-2) 비교는 이 표를 아는 쪽이 한다. 9종 전건
   * `version_no` 다(실측) — 값이 같아도 칸을 매핑에 둔다: 표마다 다를 수 있는 축이다.
   */
  versionColumn: string;
  /** 규칙 ②(취소된 후속은 안 센다)를 적용할 유형만 값을 든다 — 값 목록이 없는 축에 `'CANCELLED'` 를 지어 넣지 않고, 원장·투입은 규칙 ③이 대신한다(I-5.md R-6 ⓑ · F-6). */
  cancelledStatus: 'CANCELLED' | null;
  /**
   * PR ③a 추가 — 목록 `warehouseId` 필터를 이 유형에서 어떻게 세우는가. 표마다 자리가
   * 다르다(헤더 칸 · 헤더의 위치 관계 · 짝 전표)(I-5.md §5-3). `null`이면 이 유형엔 그 축이
   * 없어 결과가 0이다(칸 없는 필터 축의 공통 규칙 — itemId·lotId 와 같은 갈래).
   */
  warehouseFilter: ((warehouseId: number) => Record<string, unknown>) | null;
}

/** 9종 모두 `logistics` 스키마다 — 부팅 대조의 `schema_name` 쪽. */ export const DOCUMENT_SCHEMA = 'logistics';

export const DOCUMENT_TYPES: Record<LogisticsDocumentType, DocumentTypeMapping> = {
  PURCHASE_ORDER: { entityTypeCode: 'PURCHASE_ORDER', delegate: 'purchase_order', idColumn: 'purchase_order_id',
    noColumn: 'purchase_order_no', dateColumn: 'order_date', lineDelegate: 'purchase_order_line',
    plannedColumn: 'ordered_qty', processedColumn: 'received_qty', subTypeColumn: null, cancelable: false, versionColumn: 'version_no', cancelledStatus: null,
    derivedFrom: null, warehouseFilter: null },
  INBOUND_RECEIPT: { entityTypeCode: 'INBOUND_RECEIPT', delegate: 'inbound_receipt', idColumn: 'inbound_receipt_id',
    noColumn: 'inbound_receipt_no', dateColumn: 'receipt_datetime', lineDelegate: 'inbound_receipt_line',
    plannedColumn: null, processedColumn: 'received_qty', subTypeColumn: null, cancelable: true, versionColumn: 'version_no', cancelledStatus: null,
    // 입하의 dock_location_id 는 도크지 보관 창고가 아니다 — warehouseId 를 주면 0행(I-5.md §5-3).
    derivedFrom: null, warehouseFilter: null },
  GOODS_RECEIPT: { entityTypeCode: 'GOODS_RECEIPT', delegate: 'goods_receipt', idColumn: 'goods_receipt_id',
    noColumn: 'goods_receipt_no', dateColumn: 'receipt_datetime', lineDelegate: 'goods_receipt_line',
    plannedColumn: 'expected_qty', processedColumn: 'receipt_qty', subTypeColumn: 'receipt_type_code', cancelable: true, versionColumn: 'version_no', cancelledStatus: 'CANCELLED',
    derivedFrom: null, warehouseFilter: (warehouseId) => ({ warehouse_id: warehouseId }) },
  MATERIAL_ISSUE_REQUEST: { entityTypeCode: 'MATERIAL_ISSUE_REQUEST', delegate: 'material_issue_request', idColumn: 'material_issue_request_id',
    noColumn: 'issue_request_no', dateColumn: 'created_at', lineDelegate: 'material_issue_request_line',
    plannedColumn: 'requested_qty', processedColumn: 'issued_qty', subTypeColumn: null, cancelable: false, versionColumn: 'version_no', cancelledStatus: null,
    derivedFrom: null, warehouseFilter: (warehouseId) => ({ location: { warehouse_id: warehouseId } }) },
  PICKING_ORDER: { entityTypeCode: 'PICKING_ORDER', delegate: 'picking_order', idColumn: 'picking_order_id',
    noColumn: 'picking_order_no', dateColumn: 'created_at', lineDelegate: 'picking_line',
    plannedColumn: 'planned_qty', processedColumn: 'picked_qty', subTypeColumn: null, cancelable: false, versionColumn: 'version_no', cancelledStatus: null,
    derivedFrom: null, warehouseFilter: (warehouseId) => ({ warehouse_id: warehouseId }) },
  STOCK_TRANSFER: { entityTypeCode: 'STOCK_TRANSFER', delegate: 'stock_transfer', idColumn: 'stock_transfer_id',
    noColumn: 'stock_transfer_no', dateColumn: 'requested_at', lineDelegate: 'stock_transfer_line',
    plannedColumn: 'requested_qty', processedColumn: 'received_qty', subTypeColumn: null, cancelable: false, versionColumn: 'version_no', cancelledStatus: null,
    derivedFrom: null, warehouseFilter: (warehouseId) => ({ from_warehouse_id: warehouseId }) },
  SUBCONTRACT_ISSUE: { entityTypeCode: 'SUBCONTRACT_ISSUE', delegate: 'subcontract_issue', idColumn: 'subcontract_issue_id',
    noColumn: null, dateColumn: 'issued_at', lineDelegate: null,
    plannedColumn: null, processedColumn: null, subTypeColumn: null, cancelable: false, versionColumn: 'version_no', cancelledStatus: null,
    derivedFrom: 'goods_issue', warehouseFilter: (warehouseId) => ({ goods_issue: { source_warehouse_id: warehouseId } }) },
  SUBCONTRACT_RECEIPT: { entityTypeCode: 'SUBCONTRACT_RECEIPT', delegate: 'subcontract_receipt', idColumn: 'subcontract_receipt_id',
    noColumn: null, dateColumn: 'received_at', lineDelegate: null,
    plannedColumn: null, processedColumn: null, subTypeColumn: null, cancelable: false, versionColumn: 'version_no', cancelledStatus: null,
    derivedFrom: 'goods_receipt', warehouseFilter: (warehouseId) => ({ goods_receipt: { warehouse_id: warehouseId } }) },
  GOODS_ISSUE: { entityTypeCode: 'GOODS_ISSUE', delegate: 'goods_issue', idColumn: 'goods_issue_id',
    noColumn: 'goods_issue_no', dateColumn: 'issued_at', lineDelegate: 'goods_issue_line',
    plannedColumn: null, processedColumn: 'issue_qty', subTypeColumn: 'issue_type_code', cancelable: true, versionColumn: 'version_no', cancelledStatus: 'CANCELLED',
    derivedFrom: null, warehouseFilter: (warehouseId) => ({ source_warehouse_id: warehouseId }) },
};

/**
 * 부팅 시 1회 대조 — 9종의 `(schema_name, table_name)` 이 등록부에 있는가. 어긋나면 «경고만» 하고
 * 던지지 않는다: 등록부가 비어도 서비스는 떠야 하고 매핑의 정본은 위 표다(plan-integration §9 #5).
 * ⚠ 후속 축의 `INVENTORY_TRANSACTION` 은 PK 가 `(id, business_date)` 복합이라 등록부의
 *   `id_column_name` 한 칸과 안 맞는다 — 대조에만 쓰므로 그대로 둔다(I-5.md R-6).
 */
@Injectable()
export class DocumentTypeRegistryChecker implements OnModuleInit {
  private readonly logger = new Logger(DocumentTypeRegistryChecker.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
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
    } catch (error) {
      // 조회가 실패해도 부팅을 막지 않는다 — 매핑의 정본은 위 표고 대조는 알림일 뿐이다.
      this.logger.warn(`entity_type_registry 대조를 건너뛴다: ${String(error)}`);
    }
  }
}
