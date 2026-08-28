#!/usr/bin/env python3
"""Generate logical specification, API mapping, and interactive HTML."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from api_mapping import build_api_mapping
from catalog import SCHEMA_TITLES, catalog_summary, load_catalog, table_index
from html_renderer import render_html


ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs" / "data-model"
CATALOG_PATH = DOCS / "model-catalog.json"
REVIEW_PATH = DOCS / "review-findings.json"
# 계약 사본은 contracts/ 하나뿐이다. 설계 저장소에서 받아오는 것은
# scripts/contracts/update.mjs 소관이고, 여기서는 받아온 결과만 읽는다.
OPENAPI_DIR = ROOT / "contracts"

GAPS = [
    ("다국어 명칭", "app.localized_text + entity_type_registry", "해결"),
    ("ERP·레거시 원천 식별", "integration.record_provenance", "해결"),
    ("자체 비밀번호 인증", "app.user_credential", "기존 해결"),
    ("법인 단위 데이터 접근범위", "app.user_data_scope.legal_entity_id", "해결"),
    ("다형 대상 테이블 검증", "app.entity_type_registry", "해결"),
    ("품목 LOT·개발·재활용 속성", "mdm.item 확장", "해결"),
    ("기본 라우팅 단일 선택", "planning.routing.is_default + 부분 유니크", "해결"),
    ("외주 공정 구분", "planning.routing_operation.is_subcontract", "해결"),
    ("검사 생략·간이판정·샘플링 비율", "quality.inspection_plan/version 확장", "해결"),
    (
        "불량-공정 N:M과 처분 유형",
        "quality.defect_code_process + defect_code 확장",
        "해결",
    ),
    ("보전·점검·고장·비가동", "maintenance 스키마 10개 테이블", "해결"),
    (
        "인터페이스 정의·품목별 송신",
        "integration.interface_definition/outbound_item_setting",
        "해결",
    ),
    ("긴급 작업지시", "work_order.production_plan_id 선택화", "해결"),
    ("LOT별 BOM 스냅샷", "trace.lot.bom_id/bom_version", "해결"),
    ("선발행 LOT 0 수량", "PREISSUED 조건부 허용", "해결"),
    ("설비 위치·그룹·점검항목", "mdm.equipment 및 신규 매핑 테이블", "해결"),
    ("창고 내 로케이션 이동", "stock_transfer 창고 제약 완화 + 상세 위치 차이", "해결"),
    ("수리 실행 실적", "quality.repair_result", "해결"),
    ("불량 발생 원천 축·동시성", "quality.defect_record 확장", "해결"),
    ("계획 자원 복수 배정", "production.work_order_resource_assignment", "해결"),
    ("생산오더 변경 확인 이력", "production.production_order_acknowledgement", "해결"),
    ("재고조정 상세", "inventory.inventory_adjustment_line", "해결"),
    ("공지·알림·구독", "app.notice/notification 계열", "해결"),
    ("문서 출력 프린터", "app.printer + document_issue_log", "해결"),
    ("LOT 보류 해제 사유", "trace.lot_hold.release_reason_code", "해결"),
    ("외주 입출고 상태·버전", "subcontract_issue/receipt 확장", "해결"),
    ("취소 감사", "app.document_cancellation + 핵심 전표 취소 컬럼", "해결"),
    ("출하 시간대·확정자", "shipment_request/shipment 확장", "해결"),
    ("포장단위 재구성", "inventory.handling_unit_reconfiguration 계열", "해결"),
    ("작업달력·계획정지", "mdm.work_calendar 계열 + maintenance.planned_stop", "해결"),
    (
        "미결 업무코드 50종",
        "app.code_t + mdm.code_group/value로 외부화",
        "코드값 결정 대기",
    ),
]


def md_escape(value: Any) -> str:
    return (
        str(value if value is not None else "").replace("|", "\\|").replace("\n", " ")
    )


def key_marker(table: dict[str, Any], column_name: str) -> str:
    markers: list[str] = []
    if column_name in table["primary_key"]:
        markers.append("PK")
    for fk in table["foreign_keys"]:
        if column_name in fk["columns"]:
            markers.append(f"FK→{fk['target_schema']}.{fk['target_table']}")
    return ", ".join(markers) or "-"


def render_basis(catalog: dict[str, Any], mapping: dict[str, Any]) -> str:
    summary = catalog_summary(catalog)
    gap_rows = "\n".join(
        f"| {index} | {md_escape(gap)} | {md_escape(resolution)} | {status} |"
        for index, (gap, resolution, status) in enumerate(GAPS, 1)
    )
    schema_rows = "\n".join(
        f"| `{schema}` | {SCHEMA_TITLES.get(schema, schema)} | {count} |"
        for schema, count in summary["schemas"].items()
    )
    return f"""# OMF-MES 데이터 모델 v4 설계 기준

## 1. 설계 기준선

- 모델 기준선: `CREFLEINC/omf-mes` commit `{catalog["design_reference_commit"]}` (2026-08-25) — 물리 모델이 보고 만들어진 계약
- 매핑 기준선: 같은 저장소 commit `{mapping.get("contract_reference_commit", "unknown")[:7]}` — 아래 API 수치가 대조한 계약
- 계약 우선순위: 최신 Wiki 결정·공유계약 → OpenAPI → 화면 상세명세 → 과거 v3 모델
- 구현 기준선: 현재 `prisma/schema.prisma`와 모든 순방향 마이그레이션
- 대상 DBMS: PostgreSQL 16
- 결과 모델: v4.0, 물리 테이블 {summary["table_count"]}개(논리 {summary["logical_table_count"]}개, 파티션 {summary["partition_count"]}개), 컬럼 {summary["column_count"]}개, FK {summary["relationship_count"]}개
- API 추적성: OpenAPI 작업 {mapping["operation_count"]}개 중 {mapping["mapped_operation_count"]}개 매핑, 커버리지 {mapping["coverage"]}

FK {summary["relationship_count"]}개는 `pg_catalog` 행 수다. 선언된 `FOREIGN KEY` 문장은 528개이며,
차이 5건은 파티션 부모·자식에 복제된 제약이다.

설계 저장소의 최신 결정은 데이터 모델의 소유권을 백엔드로 이관한다. 과거 v3 모델은 출발점으로만 사용하고, 최신 계약에서 확정된 필드·관계·상태 전이를 v4 순방향 확장으로 반영했다.

## 2. 모델링 원칙

1. 최신 OpenAPI의 필드와 필수 여부를 물리 모델의 기존 `NOT NULL`에서 역추론하지 않는다.
2. 기존 테이블·컬럼은 삭제하지 않는다. 상태 범위 확대는 제약 완화와 신규 이력 테이블로 처리한다.
3. 품질상태는 LOT의 단일 상태가 아니라 `inventory.inventory_balance`의 재고 차원으로 유지하고, 변경 이력은 `trace.lot_status_event`에 남긴다.
4. `business_date`는 timestamptz 단순 형변환으로 만들지 않고 공장 시간대와 교대 기준으로 산출한다.
5. 미결 업무코드는 DB enum으로 고정하지 않는다. `app.code_t`와 `mdm.code_group/code_value`에서 배포 시점 코드값을 관리한다.
6. API 쓰기는 멱등·감사·낙관적 잠금 계약을 교차 검증한다. 멱등 헤더가 있는 쓰기는 `app.idempotency_record`, 모든 쓰기는 `audit.audit_event`와 연결한다.
7. 다형 대상은 물리 FK를 가장할 수 없으므로 `app.entity_type_registry`로 허용 테이블과 ID 컬럼을 등록한다.

## 3. 스키마 구성

| 스키마 | 역할 | 테이블 수 |
|---|---|---:|
{schema_rows}

## 4. 계약 차이 해소표

아래 「상태」는 **v4 동결 시점(2026-08-25)의 판정**이다. 그 뒤 계약이 바뀌어 판정이 달라진
항목이 있다 — 2026-08-28 재검토가 6·16·18·28번의 재판정과 미등재 1건(판정유형 통제속성)을
확인했다. 현재 판정은 `05-재검토-2026-08-28.md` 와 `03-data-model-api-map.html` 의
「재검토 결과」 탭을 본다.

| No. | 확인된 차이 | v4 반영 | 상태(동결 시점) |
|---:|---|---|---|
{gap_rows}

## 5. 논리 설계 동결 판단

- 구조 차이는 모두 테이블·컬럼·관계 또는 명시적인 외부 코드 정책으로 귀결됐다.
- 미결 업무코드 50종은 값의 확정 문제이며 테이블 구조 변경을 요구하지 않는다.
- 긴급 작업지시, 선발행 LOT, 창고 내 이동처럼 기존 제약으로 불가능했던 흐름은 데이터 손실 없이 허용했다.
- 정정된 LOT 품질상태 계약은 중복 컬럼을 만들지 않고 재고 차원과 이벤트 이력으로 구현했다.
- 따라서 본 문서와 `01-logical-table-spec.md`를 논리 모델 v4.0의 동결 기준으로 삼는다.

## 6. 산출물 연결

- 논리 테이블 명세: `01-logical-table-spec.md` 및 XLSX
- 물리 전체 DDL: `02-omf-mes-postgresql-v4.sql`
- 배포용 순방향 SQL: `prisma/migrations/20260826000000_data_model_v4/migration.sql`
- API 관계 명세: `api-table-map.yaml`
- 대화형 검증 자료: `03-data-model-api-map.html`
- 재검토 결과: `05-재검토-2026-08-28.md` · 기계 판독본 `review-findings.json`
"""


def render_logical_spec(catalog: dict[str, Any]) -> str:
    summary = catalog_summary(catalog)
    by_schema: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for table in catalog["tables"]:
        by_schema[table["schema"]].append(table)
    lines = [
        "# OMF-MES 논리 테이블 명세서 v4.0",
        "",
        f"> 설계 기준 `{catalog['design_reference_commit']}` · 논리 테이블 {summary['logical_table_count']}개 · 물리 파티션 {summary['partition_count']}개 · 컬럼 {summary['column_count']}개",
        "",
        "## 범례",
        "",
        "- MASTER: 기준정보, TRANSACTION: 업무 헤더, DETAIL: 상세, EVENT: 이력·감사, PARTITION: 물리 파티션",
        "- 필수는 최종 PostgreSQL 카탈로그의 `NOT NULL` 기준이며 API 요청 필수 여부와 동일한 개념이 아니다.",
        "",
    ]
    for schema in sorted(by_schema):
        tables = sorted(by_schema[schema], key=lambda item: item["name"])
        lines += [
            f"## {schema} — {SCHEMA_TITLES.get(schema, schema)}",
            "",
            "| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |",
            "|---|---|---|---:|---|---:|---|",
        ]
        for table in tables:
            lines.append(
                f"| `{table['qualified_name']}` | {md_escape(table['logical_name'])} | {table['lifecycle']} | {len(table['columns'])} | `{md_escape(', '.join(table['primary_key']) or '-')}` | {len(table['foreign_keys'])} | {md_escape(table['purpose'])} |"
            )
        lines.append("")
        for table in tables:
            lines += [
                f"### {table['qualified_name']} — {table['logical_name']}",
                "",
                table["purpose"],
                "",
                f"- 유형: `{table['lifecycle']}`",
                f"- 기본키: `{', '.join(table['primary_key']) or '-'}`",
                f"- 직접 외래키: {len(table['foreign_keys'])}개",
                "",
                "| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |",
                "|---:|---|---|:---:|---|---|",
            ]
            for column in table["columns"]:
                lines.append(
                    f"| {column['ordinal']} | `{column['name']}` | `{md_escape(column['data_type'])}` | {'N' if column['nullable'] else 'Y'} | {md_escape(key_marker(table, column['name']))} | `{md_escape(column['default']) or '-'}` |"
                )
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def yaml_quote(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_mapping_yaml(mapping: dict[str, Any]) -> str:
    lines = [
        f"mapping_version: {yaml_quote(mapping['mapping_version'])}",
        f"design_reference_commit: {yaml_quote(mapping['design_reference_commit'])}",
        f"contract_reference_commit: {yaml_quote(mapping['contract_reference_commit'])}",
        f"operation_count: {mapping['operation_count']}",
        f"mapped_operation_count: {mapping['mapped_operation_count']}",
        f"coverage: {yaml_quote(mapping['coverage'])}",
        "operations:",
    ]
    for operation in mapping["operations"]:
        lines += [
            f"  - id: {yaml_quote(operation['id'])}",
            f"    domain: {yaml_quote(operation['domain'])}",
            f"    method: {operation['method']}",
            f"    path: {yaml_quote(operation['path'])}",
            f"    summary: {yaml_quote(operation['summary'])}",
            f"    tags: {yaml_quote(operation['tags'])}",
            f"    deprecated: {str(operation['deprecated']).lower()}",
            f"    idempotency_key: {str(operation['idempotency_key']).lower()}",
            f"    if_match: {str(operation['if_match']).lower()}",
            f"    missing_tables: {yaml_quote(operation['missing_tables'])}",
            "    tables:",
        ]
        for relation in operation["tables"]:
            lines += [
                f"      - table: {yaml_quote(relation['table'])}",
                f"        role: {relation['role']}",
                f"        access: {relation['access']}",
                f"        basis: {relation['basis']}",
            ]
    return "\n".join(lines) + "\n"


def validate(catalog: dict[str, Any], mapping: dict[str, Any]) -> dict[str, Any]:
    known = table_index(catalog)
    table_names = [table["qualified_name"] for table in catalog["tables"]]
    duplicate_tables = [
        name for name, count in Counter(table_names).items() if count > 1
    ]
    unknown_relation_tables = sorted(
        {
            name
            for relation in catalog["relationships"]
            for name in (
                f"{relation['source_schema']}.{relation['source_table']}",
                f"{relation['target_schema']}.{relation['target_table']}",
            )
            if name not in known
        }
    )
    unknown_api_tables = sorted(
        {
            relation["table"]
            for operation in mapping["operations"]
            for relation in operation["tables"]
            if relation["table"] not in known
        }
    )
    operation_ids = [operation["id"] for operation in mapping["operations"]]
    duplicate_operations = sorted(
        name for name, count in Counter(operation_ids).items() if count > 1
    )
    errors = (
        duplicate_tables
        + unknown_relation_tables
        + unknown_api_tables
        + duplicate_operations
    )
    # 계약이 선언했으나 물리 모델에 없는 테이블. 생성기 결함이 아니라 모델 결손이므로
    # 실패로 죽이지 않고 상태와 목록으로 남긴다 — 죽이면 보고서 갱신 자체가 막힌다.
    gap_operations = [
        {"id": operation["id"], "missing_tables": operation["missing_tables"]}
        for operation in mapping["operations"]
        if operation.get("missing_tables")
    ]
    contract_model_gaps = sorted(
        {table for gap in gap_operations for table in gap["missing_tables"]}
    )
    report = {
        "status": "FAIL"
        if errors
        else ("PASS_WITH_GAPS" if contract_model_gaps else "PASS"),
        "model_version": catalog["model_version"],
        "design_reference_commit": catalog["design_reference_commit"],
        "contract_reference_commit": mapping.get("contract_reference_commit", "unknown"),
        **catalog_summary(catalog),
        "api_operation_count": mapping["operation_count"],
        "mapped_operation_count": mapping["mapped_operation_count"],
        "coverage": mapping["coverage"],
        "contract_model_gaps": contract_model_gaps,
        "gap_operations": gap_operations,
        "unknown_api_tables": unknown_api_tables,
        "unknown_relationship_tables": unknown_relation_tables,
        "duplicate_operations": duplicate_operations,
        "errors": errors,
    }
    if errors:
        raise ValueError(
            f"Artifact validation failed: {json.dumps(report, ensure_ascii=False)}"
        )
    return report


def build_workbook_payload(
    catalog: dict[str, Any], mapping: dict[str, Any], report: dict[str, Any]
) -> dict[str, Any]:
    tables = [
        {
            "schema": table["schema"],
            "table": table["name"],
            "qualified_name": table["qualified_name"],
            "logical_name": table["logical_name"],
            "lifecycle": table["lifecycle"],
            "purpose": table["purpose"],
            "column_count": len(table["columns"]),
            "primary_key": ", ".join(table["primary_key"]),
            "foreign_key_count": len(table["foreign_keys"]),
            "is_partition": table["is_partition"],
        }
        for table in catalog["tables"]
    ]
    columns = [
        {
            "qualified_table": table["qualified_name"],
            "schema": table["schema"],
            "table": table["name"],
            "ordinal": column["ordinal"],
            "column": column["name"],
            "data_type": column["data_type"],
            "required": not column["nullable"],
            "key_reference": key_marker(table, column["name"]),
            "default": column["default"] or "",
        }
        for table in catalog["tables"]
        for column in table["columns"]
    ]
    relationships = [
        {
            "name": relation["name"],
            "source_table": f"{relation['source_schema']}.{relation['source_table']}",
            "source_columns": ", ".join(relation["source_columns"]),
            "target_table": f"{relation['target_schema']}.{relation['target_table']}",
            "target_columns": ", ".join(relation["target_columns"]),
            "on_delete": relation["on_delete"],
        }
        for relation in catalog["relationships"]
    ]
    api_rows = [
        {
            "domain": operation["domain"],
            "method": operation["method"],
            "path": operation["path"],
            "summary": operation["summary"],
            "table": relation["table"],
            "role": relation["role"],
            "access": relation["access"],
            "basis": relation["basis"],
            "idempotency_key": operation["idempotency_key"],
            "if_match": operation["if_match"],
        }
        for operation in mapping["operations"]
        for relation in operation["tables"]
    ]
    api_operations = [
        {
            "id": operation["id"],
            "domain": operation["domain"],
            "method": operation["method"],
            "path": operation["path"],
            "summary": operation["summary"],
            "tags": ", ".join(operation["tags"]),
            "deprecated": operation["deprecated"],
            "idempotency_key": operation["idempotency_key"],
            "if_match": operation["if_match"],
            "relation_count": len(operation["tables"]),
            # 계약이 선언한 테이블이 모델에 없으면 나머지가 매핑됐어도 「완료」가 아니다.
            # PASS 는 보고서의 mapped_operation_count 와 같은 정의여야 한다 — 정의가
            # 갈리면 Validation 시트의 Expected/Actual 이 영원히 어긋난다.
            "mapping_status": (
                "FAIL"
                if not operation["tables"]
                else ("PARTIAL" if operation["missing_tables"] else "PASS")
            ),
        }
        for operation in mapping["operations"]
    ]
    return {
        "model_version": catalog["model_version"],
        "design_reference_commit": catalog["design_reference_commit"],
        "summary": report,
        "tables": tables,
        "columns": columns,
        "relationships": relationships,
        "api_operations": api_operations,
        "api_mapping": api_rows,
        "gaps": [
            {"no": index, "gap": gap, "resolution": resolution, "status": status}
            for index, (gap, resolution, status) in enumerate(GAPS, 1)
        ],
    }


def write_or_check(path: Path, content: str, check: bool) -> None:
    if check:
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            raise ValueError(f"Generated artifact is stale: {path.relative_to(ROOT)}")
        return
    path.write_text(content, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check", action="store_true", help="fail when generated artifacts are stale"
    )
    args = parser.parse_args()
    catalog = load_catalog(CATALOG_PATH)
    mapping = build_api_mapping(catalog, OPENAPI_DIR)
    review = json.loads(REVIEW_PATH.read_text(encoding="utf-8"))
    report = validate(catalog, mapping)
    write_or_check(
        DOCS / "00-design-basis-and-decisions.md",
        render_basis(catalog, mapping),
        args.check,
    )
    write_or_check(
        DOCS / "01-logical-table-spec.md", render_logical_spec(catalog), args.check
    )
    write_or_check(
        DOCS / "api-table-map.yaml", render_mapping_yaml(mapping), args.check
    )
    write_or_check(
        DOCS / "api-table-map.json",
        json.dumps(mapping, ensure_ascii=False, indent=2) + "\n",
        args.check,
    )
    write_or_check(
        DOCS / "workbook-data.json",
        json.dumps(
            build_workbook_payload(catalog, mapping, report),
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        args.check,
    )
    write_or_check(
        DOCS / "03-data-model-api-map.html",
        render_html(catalog, mapping, review),
        args.check,
    )
    write_or_check(
        DOCS / "validation-report.json",
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        args.check,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
