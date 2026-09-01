"""Build and validate OpenAPI-to-table mappings."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

from catalog import table_index


# Longest path match wins.  The first table is the aggregate root; following
# tables are contractually coupled detail/history/configuration stores.
RESOURCE_TABLES: dict[str, list[str]] = {
    "/app/approval-routes/{approvalRouteId}/steps": [
        "app.approval_route_step",
        "app.approval_route",
    ],
    "/app/approval-routes": ["app.approval_route", "app.approval_route_step"],
    "/app/approval-requests": ["app.approval_request", "app.approval_step"],
    # `/content` 까지 같은 접두사로 덮는다. 계약 `Attachment` 8필드가 물리 8칸과
    # 그대로 맞는다 — `contentType`=`mime_type`, `byteSize`=`file_size`.
    "/app/attachments": ["app.attachment"],
    "/app/document-issues": ["app.document_issue_log", "app.printer", "app.attachment"],
    "/app/notification-subscriptions": ["app.notification_subscription"],
    "/app/notification-events": ["app.notification_event", "app.notification"],
    "/app/notifications": ["app.notification", "app.notification_event"],
    "/app/notices": ["app.notice", "app.notice_acknowledgement"],
    "/app/operation-policies": ["app.operation_policy"],
    "/app/printers": ["app.printer"],
    "/app/roles/{roleId}/permissions": ["app.role_permission", "app.role"],
    "/app/roles": ["app.role", "app.role_permission"],
    "/app/users/{userId}/data-scopes": ["app.user_data_scope", "app.app_user"],
    "/app/users/{userId}/roles": ["app.user_role", "app.app_user", "app.role"],
    "/app/users": ["app.app_user", "app.user_credential"],
    "/app/sessions": ["app.app_user", "app.user_credential"],
    "/app/dashboard-summary": [
        "production.work_order",
        "inventory.inventory_balance",
        "quality.inspection_request",
        "maintenance.equipment_downtime",
    ],
    "/audit/events": ["audit.audit_event"],
    "/integration/interface-definitions": ["integration.interface_definition"],
    "/integration/outbound-item-settings": [
        "integration.outbound_item_setting",
        "integration.interface_definition",
        "mdm.item",
    ],
    "/integration/messages": ["integration.integration_message"],
    "/inventory/adjustments/{inventoryAdjustmentId}/lines": [
        "inventory.inventory_adjustment_line",
        "inventory.inventory_adjustment",
    ],
    "/inventory/adjustments": [
        "inventory.inventory_adjustment",
        "inventory.inventory_adjustment_line",
    ],
    "/inventory/balances": ["inventory.inventory_balance"],
    "/inventory/counts/{inventoryCountId}/lines": [
        "inventory.inventory_count_line",
        "inventory.inventory_count",
    ],
    "/inventory/counts": [
        "inventory.inventory_count",
        "inventory.inventory_count_line",
    ],
    "/inventory/handling-units/{handlingUnitId}/contents": [
        "inventory.handling_unit_content",
        "inventory.handling_unit",
    ],
    "/inventory/handling-units": [
        "inventory.handling_unit",
        "inventory.handling_unit_content",
        "inventory.handling_unit_reconfiguration",
    ],
    "/inventory/reservations": ["inventory.inventory_reservation"],
    "/inventory/transactions": [
        "inventory.inventory_transaction",
        "inventory.inventory_transaction_line",
    ],
    "/logistics/asns": ["logistics.asn", "logistics.asn_line"],
    "/logistics/document-progress": [
        "logistics.purchase_order",
        "logistics.asn",
        "logistics.inbound_receipt",
        "logistics.goods_receipt",
    ],
    "/logistics/goods-issues/{goodsIssueId}/lines": [
        "logistics.goods_issue_line",
        "logistics.goods_issue",
    ],
    "/logistics/goods-issues": ["logistics.goods_issue", "logistics.goods_issue_line"],
    "/logistics/goods-receipts/{goodsReceiptId}/lines": [
        "logistics.goods_receipt_line",
        "logistics.goods_receipt",
    ],
    "/logistics/goods-receipts": [
        "logistics.goods_receipt",
        "logistics.goods_receipt_line",
    ],
    "/logistics/inbound-receipt-lines": [
        "logistics.inbound_variance",
        "logistics.inbound_receipt_line",
    ],
    "/logistics/inbound-receipts/{inboundReceiptId}/lines": [
        "logistics.inbound_receipt_line",
        "logistics.inbound_receipt",
        "logistics.inbound_variance",
    ],
    "/logistics/inbound-receipts": [
        "logistics.inbound_receipt",
        "logistics.inbound_receipt_line",
    ],
    "/logistics/material-issue-requests": [
        "logistics.material_issue_request",
        "logistics.material_issue_request_line",
    ],
    "/logistics/picking-orders": [
        "logistics.picking_order",
        "logistics.picking_line",
        "inventory.inventory_reservation",
    ],
    "/logistics/purchase-orders/{purchaseOrderId}/lines": [
        "logistics.purchase_order_line",
        "logistics.purchase_order",
    ],
    "/logistics/purchase-orders": [
        "logistics.purchase_order",
        "logistics.purchase_order_line",
    ],
    "/logistics/putaway-rules": ["logistics.putaway_rule"],
    "/logistics/putaway-tasks": ["logistics.putaway_task", "logistics.putaway_rule"],
    "/logistics/recycle-entries": ["logistics.recycle_entry"],
    "/logistics/sales-orders": ["logistics.sales_order", "logistics.sales_order_line"],
    "/logistics/shipment-lot-allocations": [
        "logistics.shipment_lot_allocation",
        "logistics.shipment_line",
    ],
    "/logistics/shipment-requests": [
        "logistics.shipment_request",
        "logistics.shipment_request_line",
    ],
    "/logistics/shipments": [
        "logistics.shipment",
        "logistics.shipment_line",
        "logistics.shipment_lot_allocation",
    ],
    "/logistics/shopfloor-receipts": [
        "logistics.shopfloor_receipt",
        "logistics.shopfloor_receipt_line",
    ],
    "/logistics/stock-transfers/{stockTransferId}/lines": [
        "logistics.stock_transfer_line",
        "logistics.stock_transfer",
    ],
    # 재고 재등록. 새 표를 세우지 않는다 — 응답이 stockTransferId·stockTransferNo 를
    # 내므로 이동 문서를 만들어 쓰고, 반출·도착이 한 번에 끝나 received_at 이 채워진
    # 상태로 생긴다. 보류 해제와 LOT 상태 전이를 같은 트랜잭션에서 한다.
    "/logistics/stock-reinstatements": [
        "logistics.stock_transfer",
        "trace.lot_hold",
        "trace.lot",
        "quality.disposition_decision",
    ],
    "/logistics/stock-transfers": [
        "logistics.stock_transfer",
        "logistics.stock_transfer_line",
    ],
    "/maintenance/breakdowns": [
        "maintenance.breakdown",
        "maintenance.equipment_downtime",
        "app.attachment",
    ],
    "/maintenance/calibrations": ["quality.equipment_calibration", "mdm.equipment"],
    "/maintenance/collection-channels/{collectionChannelId}/observations": [
        "maintenance.collection_observation",
        "maintenance.collection_channel",
    ],
    "/maintenance/collection-channels": ["maintenance.collection_channel"],
    "/maintenance/downtimes": [
        "maintenance.equipment_downtime",
        "maintenance.breakdown",
    ],
    "/maintenance/inspections": [
        "maintenance.equipment_inspection",
        "maintenance.equipment_inspection_result",
    ],
    "/maintenance/orders": ["maintenance.maintenance_order", "maintenance.breakdown"],
    "/maintenance/results": [
        "maintenance.maintenance_result",
        "maintenance.maintenance_order",
    ],
    "/maintenance/tool-usages": ["maintenance.tool_usage", "mdm.mold"],
    "/mdm/equipment-groups/{equipmentGroupId}/inspection-items": [
        "mdm.equipment_group_inspection_item",
        "mdm.equipment_group",
    ],
    "/mdm/equipment-groups": ["mdm.equipment_group", "mdm.equipment_group_member"],
    "/mdm/equipment-inspection-items": ["mdm.equipment_inspection_item"],
    "/mdm/equipments/{equipmentId}/inspection-items": [
        "mdm.equipment_inspection_item_assignment",
        "mdm.equipment",
    ],
    "/mdm/equipments": ["mdm.equipment"],
    "/mdm/items/{itemId}/bu-item-maps": ["mdm.item_bu_item_map", "mdm.item"],
    "/mdm/items/{itemId}/external-codes": ["mdm.item_external_code", "mdm.item"],
    "/mdm/items/{itemId}/uom-conversions": ["mdm.item_uom_conversion", "mdm.item"],
    "/mdm/items": ["mdm.item"],
    "/mdm/code-groups": ["mdm.code_group"],
    "/mdm/code-values": ["mdm.code_value"],
    # 판정유형 통제속성(`#42` §I-11). 코드값과 1:1 인 별표로 세웠다 — 통제 속성이
    # 판정유형에만 붙어 code_value 에 컬럼으로 달면 나머지 전부에 NULL 이 생긴다.
    "/mdm/judgment-type-controls": ["mdm.judgment_type_control", "mdm.code_value"],
    "/mdm/departments": ["mdm.department"],
    "/mdm/business-units": ["mdm.business_unit"],
    "/mdm/legal-entities": ["mdm.legal_entity"],
    "/mdm/locations": ["mdm.location"],
    "/mdm/molds": ["mdm.mold"],
    "/mdm/partners/{partnerId}/roles": ["mdm.partner_role", "mdm.partner"],
    "/mdm/partners": ["mdm.partner"],
    "/mdm/plants": ["mdm.plant"],
    "/mdm/processes": ["mdm.process"],
    "/mdm/production-lines": ["mdm.production_line"],
    "/mdm/shifts": ["mdm.shift"],
    "/mdm/spare-parts/{sparePartId}/equipments": [
        "mdm.spare_part_equipment",
        "mdm.spare_part",
    ],
    "/mdm/spare-parts": ["mdm.spare_part", "mdm.spare_part_equipment"],
    "/mdm/terminals/{terminalId}/processes": ["mdm.terminal_process", "mdm.terminal"],
    "/mdm/terminals": ["mdm.terminal"],
    "/mdm/uoms": ["mdm.uom"],
    "/mdm/warehouses/{warehouseId}/layout": ["mdm.warehouse_layout", "mdm.warehouse"],
    "/mdm/warehouses": ["mdm.warehouse"],
    "/mdm/work-calendar-applications": [
        "mdm.work_calendar_application",
        "mdm.work_calendar",
    ],
    "/mdm/work-calendars/{workCalendarId}/days": [
        "mdm.work_calendar_day",
        "mdm.work_calendar",
    ],
    "/mdm/work-calendars": ["mdm.work_calendar", "mdm.work_calendar_day"],
    "/mdm/workers/{workerId}/qualifications": [
        "mdm.worker_qualification",
        "mdm.worker",
    ],
    "/mdm/workers": ["mdm.worker"],
    "/planning/boms/{bomId}/components": ["planning.bom_component", "planning.bom"],
    "/planning/boms": ["planning.bom", "planning.bom_component"],
    "/planning/production-orders": [
        "planning.production_order",
        "production.production_order_acknowledgement",
    ],
    "/planning/production-plans": ["planning.production_plan"],
    "/planning/routings/{routingId}/operation-dependencies": [
        "planning.routing_operation_dependency",
        "planning.routing",
    ],
    "/planning/routings/{routingId}/operations": [
        "planning.routing_operation",
        "planning.routing",
    ],
    "/planning/routings": ["planning.routing", "planning.routing_operation"],
    "/production/material-consumptions": [
        "production.material_consumption",
        "production.material_usage_allocation",
    ],
    "/production/material-returns": [
        "production.material_return",
        "production.material_return_line",
    ],
    "/production/operation-handovers": [
        "production.operation_handover",
        "production.operation_handover_line",
    ],
    "/production/production-results": [
        "production.production_result",
        "production.production_result_lot_allocation",
    ],
    "/production/work-orders": [
        "production.work_order",
        "production.work_order_resource_assignment",
    ],
    "/production/work-sessions/{workSessionId}/events": [
        "production.work_session_event",
        "production.work_session",
    ],
    "/production/work-sessions/{workSessionId}/workers": [
        "production.work_session_worker",
        "production.work_session",
    ],
    "/production/work-sessions": ["production.work_session"],
    "/quality/cause-codes": ["quality.cause_code"],
    "/quality/concessions": ["quality.concession"],
    "/quality/defect-codes": ["quality.defect_code", "quality.defect_code_process"],
    "/quality/defect-records": ["quality.defect_record"],
    "/quality/disposition-decisions": ["quality.disposition_decision"],
    "/quality/inspection-plan-versions/{inspectionPlanVersionId}/items": [
        "quality.inspection_item_spec",
        "quality.inspection_plan_version",
    ],
    "/quality/inspection-plan-versions": [
        "quality.inspection_plan_version",
        "quality.inspection_item_spec",
    ],
    "/quality/inspection-plans": [
        "quality.inspection_plan",
        "quality.inspection_plan_version",
    ],
    "/quality/inspection-requests": ["quality.inspection_request"],
    "/quality/inspection-results": [
        "quality.inspection_result",
        "quality.inspection_measurement",
        "quality.defect_record",
    ],
    "/quality/lot-hold-events": ["trace.lot_hold", "trace.lot_status_event"],
    "/quality/lot-holds": ["trace.lot_hold", "trace.lot_status_event"],
    "/quality/lot-status": ["trace.lot_status_event", "inventory.inventory_balance"],
    "/quality/nonconformances": [
        "quality.nonconformance",
        "quality.nonconformance_lot",
        "quality.disposition_decision",
    ],
    "/trace/lots/{lotId}/external-identifiers": [
        "trace.lot_external_identifier",
        "trace.lot",
    ],
    "/trace/lots/{lotId}/holds": ["trace.lot_hold", "trace.lot"],
    # 표는 있으나 계약 `LotStatusHistoryEvent` 와 컬럼이 넷 어긋난다 — `transitionCode`
    # 없음 · `reason`(text) vs `reason_code` · `changed_by` 필수 여부 · 원전표 두 칸의
    # NULL 허용. 표 자체는 이것이므로 여기 두고, 컬럼 차이는 `#59` 에서 가른다.
    "/trace/lot-status-events": ["trace.lot_status_event", "trace.lot"],
    # 생명주기 축(L1~L3). 품질 판정 축인 `trace.lot_status_event` 와 한 이력에 섞지
    # 않는다는 것이 계약 명시 사항이라 표가 둘이다(`#63`).
    "/trace/lot-lifecycle-events": ["trace.lot_lifecycle_history", "trace.lot"],
    "/trace/lots": ["trace.lot", "trace.lot_relation"],
    "/trace/serial-numbers": ["trace.serial_number", "trace.serial_component_relation"],
}

# 계약이 `x-source-table` 로 선언했으나 물리 모델에 아직 없는 테이블.
# 규칙을 비워 두면 생성기가 죽고, 아무 테이블에나 붙이면 결손이 사라진다 —
# 둘 다 하지 않고 결손인 채로 매핑에 남긴다.
#
# 2026-08-31 갱신(`231c43f`)으로 둘이 늘었다. 이 둘은 `x-source-table` 조차 없어
# 물리 자리가 통째로 우리 판단이다 — 이름은 계약이 쓴 가칭을 그대로 뒀다.
PENDING_TABLES: dict[str, list[str]] = {
    "/production/precheck-decisions": ["production.precheck_decision"],
    "/production/repair-executions": ["production.repair_execution"],
}

METHODS = {"get", "post", "put", "patch", "delete"}


def _resolve_ref(document: dict[str, Any], ref: str) -> Any:
    value: Any = document
    for token in ref.removeprefix("#/").split("/"):
        value = value[token.replace("~1", "/").replace("~0", "~")]
    return value


def _source_tables(
    document: dict[str, Any], value: Any, seen: set[str] | None = None
) -> set[str]:
    seen = set() if seen is None else seen
    result: set[str] = set()
    if isinstance(value, list):
        for item in value:
            result.update(_source_tables(document, item, seen))
    elif isinstance(value, dict):
        declared = value.get("x-source-table")
        if isinstance(declared, str):
            result.add(declared)
        elif isinstance(declared, list):
            result.update(str(item) for item in declared)
        ref = value.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/") and ref not in seen:
            seen.add(ref)
            result.update(_source_tables(document, _resolve_ref(document, ref), seen))
        for key, item in value.items():
            if key != "$ref":
                result.update(_source_tables(document, item, seen))
    return result


def _resource_tables(path: str) -> list[str]:
    matches = [
        (len(prefix), tables)
        for prefix, tables in RESOURCE_TABLES.items()
        if path.startswith(prefix)
    ]
    if not matches:
        if _pending_tables(path):
            return []
        raise ValueError(f"No resource mapping rule for {path}")
    return max(matches, key=lambda item: item[0])[1]


def _pending_tables(path: str) -> list[str]:
    matches = [
        (len(prefix), tables)
        for prefix, tables in PENDING_TABLES.items()
        if path.startswith(prefix)
    ]
    return max(matches, key=lambda item: item[0])[1] if matches else []


def _has_header(
    document: dict[str, Any], parameters: Iterable[dict[str, Any]], name: str
) -> bool:
    # 계약은 공통 헤더를 components/parameters 의 $ref 로 쓴다. 참조를 풀지 않으면
    # Idempotency-Key·If-Match 를 선언한 오퍼레이션이 전부 「해당 없음」으로 기록된다.
    for param in parameters:
        ref = param.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            param = _resolve_ref(document, ref)
        if param.get("in") != "header":
            continue
        if param.get("name", "").lower() == name.lower():
            return True
    return False


def _main_access(method: str, path: str) -> str:
    if method == "GET":
        return "READ"
    if method == "DELETE":
        return "DELETE"
    if (
        method in {"PUT", "PATCH"}
        or ":" in path
        or re.search(
            r"/(approve|reject|confirm|cancel|close|publish|ack|retry|post|release|hold|resume|complete|start|end|read)(/|$|:)",
            path,
        )
    ):
        return "UPDATE"
    return "INSERT"


def build_api_mapping(catalog: dict[str, Any], openapi_dir: Path) -> dict[str, Any]:
    known = table_index(catalog)
    operations: list[dict[str, Any]] = []
    for file_path in sorted(openapi_dir.glob("*.json")):
        with file_path.open(encoding="utf-8") as stream:
            document = json.load(stream)
        for path, path_item in document.get("paths", {}).items():
            for method, operation in path_item.items():
                if method.lower() not in METHODS:
                    continue
                method_upper = method.upper()
                roots = _resource_tables(path)
                declared = _source_tables(document, operation)
                missing_tables = sorted(
                    set(_pending_tables(path)) | {t for t in declared if t not in known}
                )
                tables: list[dict[str, str]] = []
                for index, qualified_name in enumerate(roots):
                    tables.append(
                        {
                            "table": qualified_name,
                            "role": "PRIMARY" if index == 0 else "SUPPORTING",
                            "access": _main_access(method_upper, path)
                            if index == 0
                            else "READ",
                            "basis": "RESOURCE_RULE",
                        }
                    )
                for qualified_name in sorted(declared):
                    if qualified_name in known and qualified_name not in {
                        item["table"] for item in tables
                    }:
                        tables.append(
                            {
                                "table": qualified_name,
                                "role": "DECLARED",
                                "access": "READ",
                                "basis": "X_SOURCE_TABLE",
                            }
                        )

                parameters = list(path_item.get("parameters", [])) + list(
                    operation.get("parameters", [])
                )
                mutation = method_upper != "GET"
                if mutation and _has_header(document, parameters, "Idempotency-Key"):
                    tables.append(
                        {
                            "table": "app.idempotency_record",
                            "role": "CROSS_CUTTING",
                            "access": "UPSERT",
                            "basis": "HEADER_CONTRACT",
                        }
                    )
                if mutation:
                    tables.append(
                        {
                            "table": "audit.audit_event",
                            "role": "CROSS_CUTTING",
                            "access": "APPEND",
                            "basis": "AUDIT_POLICY",
                        }
                    )

                unique_tables: list[dict[str, str]] = []
                seen_tables: set[str] = set()
                for relation in tables:
                    if relation["table"] not in seen_tables:
                        unique_tables.append(relation)
                        seen_tables.add(relation["table"])
                missing = sorted(seen_tables - known.keys())
                if missing:
                    raise ValueError(
                        f"Unknown table(s) for {method_upper} {path}: {missing}"
                    )
                operations.append(
                    {
                        "id": f"{method_upper} {path}",
                        "domain": file_path.stem,
                        "method": method_upper,
                        "path": path,
                        "summary": operation.get("summary")
                        or operation.get("description")
                        or "",
                        "tags": operation.get("tags", []),
                        "deprecated": bool(operation.get("deprecated", False)),
                        "idempotency_key": _has_header(
                            document, parameters, "Idempotency-Key"
                        ),
                        "if_match": _has_header(document, parameters, "If-Match"),
                        "tables": unique_tables,
                        "missing_tables": missing_tables,
                    }
                )
    operations.sort(key=lambda item: (item["domain"], item["path"], item["method"]))
    if not operations:
        raise ValueError("No OpenAPI operations discovered")
    # 커버리지는 상수가 아니라 계산값이다 — 100%를 적어 두면 결손이 생겨도 100%로 보인다.
    # 쓰기는 audit·멱등 테이블이 항상 붙으므로 PRIMARY 유무로 센다.
    mapped = sum(
        any(relation["role"] == "PRIMARY" for relation in operation["tables"])
        for operation in operations
    )
    return {
        "mapping_version": "4.1",
        "design_reference_commit": catalog["design_reference_commit"],
        "contract_reference_commit": _contract_commit(openapi_dir),
        "operation_count": len(operations),
        "mapped_operation_count": mapped,
        "coverage": f"{mapped / len(operations) * 100:.1f}%",
        "operations": operations,
    }


def _contract_commit(openapi_dir: Path) -> str:
    """사본이 어느 설계 커밋에서 왔는지. scripts/contracts/update.mjs 가 적는다."""
    marker = openapi_dir / "COMMIT.txt"
    if not marker.exists():
        return "unknown"
    return marker.read_text(encoding="utf-8").strip() or "unknown"
