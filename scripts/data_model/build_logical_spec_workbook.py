#!/usr/bin/env python3
"""Build the OMF-MES logical table specification workbook.

The workbook is generated from docs/data-model/workbook-data.json.  Summary and
validation values deliberately use spreadsheet formulas so the delivery file can
detect row-count drift when users filter, extend, or replace the source sheets.
"""

from __future__ import annotations

import argparse
import json
from copy import copy
from pathlib import Path
from typing import Any, Iterable

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PAYLOAD = REPOSITORY_ROOT / "docs/data-model/workbook-data.json"
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT
    / "outputs/01a0376d-9b7c-7ce0-be72-2df4ecd65d94"
    / "omf-mes-logical-table-spec-v4.xlsx"
)

COLORS = {
    "ink": "142033",
    "blue": "2563EB",
    "canvas": "F4F7FA",
    "paper": "FFFFFF",
    "muted": "667386",
    "line": "D6E0EA",
    "header": "E7EEF7",
    "green": "16827A",
    "green_light": "DCF4EF",
    "orange": "C96D1D",
    "orange_light": "FFF0DD",
    "red": "C43D3D",
    "red_light": "FCE2E2",
    "purple": "6D4BC3",
    "purple_light": "EEE8FF",
}

THIN_BORDER = Border(
    left=Side(style="thin", color=COLORS["line"]),
    right=Side(style="thin", color=COLORS["line"]),
    top=Side(style="thin", color=COLORS["line"]),
    bottom=Side(style="thin", color=COLORS["line"]),
)

SOURCE_COMMENT = (
    "Source: docs/data-model/workbook-data.json, generated from the PostgreSQL "
    "catalog and seven OpenAPI contracts."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD)
    return parser.parse_args()


def set_title(ws, last_column: int, title: str, subtitle: str) -> None:
    last = get_column_letter(last_column)
    ws.sheet_view.showGridLines = False
    ws.merge_cells(f"A1:{last}1")
    ws["A1"] = title
    ws["A1"].font = Font(name="Arial", size=18, bold=True, color=COLORS["paper"])
    ws["A1"].fill = PatternFill("solid", fgColor=COLORS["ink"])
    ws["A1"].alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 34

    ws.merge_cells(f"A2:{last}2")
    ws["A2"] = subtitle
    ws["A2"].font = Font(name="Arial", size=10, italic=True, color=COLORS["muted"])
    ws["A2"].fill = PatternFill("solid", fgColor=COLORS["canvas"])
    ws["A2"].alignment = Alignment(vertical="center")
    ws.row_dimensions[2].height = 26

    for row in ws.iter_rows(min_row=1, max_row=2, min_col=1, max_col=last_column):
        for cell in row:
            font = copy(cell.font)
            font.name = "Arial"
            cell.font = font


def yn(value: Any) -> str:
    """Render source booleans as stable data values, not spreadsheet formulas."""

    return "Y" if bool(value) else "N"


def style_header(row: Iterable[Any], fill: str = COLORS["blue"]) -> None:
    for cell in row:
        cell.font = Font(name="Arial", size=9, bold=True, color=COLORS["paper"])
        cell.fill = PatternFill("solid", fgColor=fill)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = THIN_BORDER


def style_body(ws, min_row: int, max_row: int, max_column: int) -> None:
    for row in ws.iter_rows(
        min_row=min_row,
        max_row=max_row,
        min_col=1,
        max_col=max_column,
    ):
        for cell in row:
            cell.font = Font(name="Arial", size=9, color=COLORS["ink"])
            cell.alignment = Alignment(vertical="center")
            cell.border = THIN_BORDER


def configure_print_preview(ws, last_column: int, max_row: int) -> None:
    """Keep each sheet's print preview small enough for visual QA.

    All rows remain in the workbook.  The print area is a representative sample
    because the full data sheets contain thousands of rows.
    """

    last = get_column_letter(last_column)
    ws.print_area = f"A1:{last}{min(max_row, 25)}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "1:4"
    ws.sheet_properties.pageSetUpPr.autoPageBreaks = False
    ws.oddFooter.center.text = "OMF-MES Data Model v4 · &P / &N"
    ws.oddFooter.center.size = 8
    ws.oddFooter.center.color = COLORS["muted"]


def add_data_sheet(
    wb: Workbook,
    *,
    name: str,
    title: str,
    subtitle: str,
    headers: list[str],
    rows: list[list[Any]],
    widths: list[float],
    table_name: str,
    wrap_columns: set[int] | None = None,
) -> Any:
    ws = wb.create_sheet(name)
    set_title(ws, len(headers), title, subtitle)

    for column, value in enumerate(headers, start=1):
        ws.cell(row=4, column=column, value=value)
    style_header(ws[4])
    ws.row_dimensions[4].height = 28

    for row_index, values in enumerate(rows, start=5):
        for column, value in enumerate(values, start=1):
            ws.cell(row=row_index, column=column, value=value)

    end_row = len(rows) + 4
    style_body(ws, 5, end_row, len(headers))
    if wrap_columns:
        for column in wrap_columns:
            for row in range(5, end_row + 1):
                ws.cell(row=row, column=column).alignment = Alignment(
                    vertical="center", wrap_text=True
                )

    if rows:
        last = get_column_letter(len(headers))
        table = Table(displayName=table_name, ref=f"A4:{last}{end_row}")
        table.tableStyleInfo = TableStyleInfo(
            name="TableStyleMedium2",
            showFirstColumn=False,
            showLastColumn=False,
            showRowStripes=True,
            showColumnStripes=False,
        )
        ws.add_table(table)

    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width

    ws.freeze_panes = "D5" if len(headers) >= 3 else "A5"
    ws.auto_filter.ref = f"A4:{get_column_letter(len(headers))}{end_row}"
    configure_print_preview(ws, len(headers), end_row)
    return ws


def add_summary(wb: Workbook, payload: dict[str, Any]) -> Any:
    ws = wb.active
    ws.title = "Summary"
    set_title(
        ws,
        10,
        "OMF-MES 논리 테이블 명세서 v4.0",
        (
            f"설계 기준 {payload['design_reference_commit']} · PostgreSQL 16 · "
            "API 계약 추적성 포함"
        ),
    )

    metrics = [
        ("물리 테이블", f"=COUNTA('Tables'!C5:C{len(payload['tables']) + 4})"),
        ("논리 테이블", f"=COUNTIF('Tables'!J5:J{len(payload['tables']) + 4},\"N\")"),
        ("물리 파티션", f"=COUNTIF('Tables'!J5:J{len(payload['tables']) + 4},\"Y\")"),
        ("전체 컬럼", f"=COUNTA('Columns'!E5:E{len(payload['columns']) + 4})"),
        (
            "FK 관계",
            f"=COUNTA('Relationships'!A5:A{len(payload['relationships']) + 4})",
        ),
        (
            "OpenAPI 작업",
            f"=COUNTA('API Operations'!A5:A{len(payload['api_operations']) + 4})",
        ),
        (
            "API 매핑 커버리지",
            (
                f"=COUNTIF('API Operations'!K5:K{len(payload['api_operations']) + 4},"
                '"PASS")/B10'
            ),
        ),
    ]
    ws.append([])
    ws["A4"], ws["B4"] = "핵심 지표", "값"
    style_header(ws[4][0:2])
    for row_index, (label, formula) in enumerate(metrics, start=5):
        ws.cell(row=row_index, column=1, value=label)
        ws.cell(row=row_index, column=2, value=formula)
    style_body(ws, 5, 11, 2)
    for row in range(5, 11):
        ws.cell(row=row, column=2).number_format = "#,##0"
    ws["B11"].number_format = "0%"
    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 18

    schema_roles = {
        "app": "공통 애플리케이션",
        "audit": "감사·보안",
        "integration": "외부 연계",
        "inventory": "재고",
        "logistics": "물류",
        "maintenance": "설비보전",
        "mdm": "기준정보",
        "planning": "계획",
        "production": "생산",
        "quality": "품질",
        "trace": "추적성",
    }
    for column, value in enumerate(["스키마", "역할", "테이블 수"], start=4):
        ws.cell(row=4, column=column, value=value)
    style_header(ws[4][3:6])
    for row_index, (schema, count) in enumerate(
        payload["summary"]["schemas"].items(), start=5
    ):
        ws.cell(row=row_index, column=4, value=schema)
        ws.cell(row=row_index, column=5, value=schema_roles.get(schema, schema))
        count_cell = ws.cell(row=row_index, column=6, value=count)
        count_cell.comment = Comment(SOURCE_COMMENT, "OpenAI Codex")
    style_body(ws, 5, 4 + len(payload["summary"]["schemas"]), 6)
    ws.column_dimensions["D"].width = 18
    ws.column_dimensions["E"].width = 24
    ws.column_dimensions["F"].width = 14

    # 수치를 손으로 적으면 계약이 늘어도 옛 숫자가 남는다 — 집계에서 끌어 쓴다.
    summary = payload["summary"]
    mapped = summary["mapped_operation_count"]
    total = summary["api_operation_count"]
    gates = [
        ("PostgreSQL 마이그레이션", "PASS", "12개 순차 적용"),
        ("전체 DDL 재설치", "PASS", f"{summary['table_count']} tables"),
        ("Prisma 정합성", "PASS", f"{summary['logical_table_count']} models"),
        (
            "OpenAPI 매핑",
            "PASS" if mapped == total else "GAP",
            f"{mapped}/{total}",
        ),
        ("서버 회귀", "PASS", "19 suites · 140 tests"),
    ]
    for column, value in enumerate(["검증 게이트", "상태", "근거"], start=8):
        ws.cell(row=4, column=column, value=value)
    style_header(ws[4][7:10])
    for row_index, values in enumerate(gates, start=5):
        for column, value in enumerate(values, start=8):
            cell = ws.cell(row=row_index, column=column, value=value)
            if column in (8, 9, 10):
                cell.comment = Comment(
                    "Source: docs/data-model/04-verification-report.md", "OpenAI Codex"
                )
    style_body(ws, 5, 9, 10)
    for row in range(5, 10):
        ws.cell(row=row, column=9).fill = PatternFill(
            "solid", fgColor=COLORS["green_light"]
        )
        ws.cell(row=row, column=9).font = Font(
            name="Arial", size=9, bold=True, color=COLORS["green"]
        )
    ws.column_dimensions["H"].width = 25
    ws.column_dimensions["I"].width = 12
    ws.column_dimensions["J"].width = 24

    ws.merge_cells("A18:J18")
    ws["A18"] = (
        "읽는 법 · Summary와 Validation의 집계값은 각 상세 시트를 참조하는 수식입니다. "
        "Expected 및 검증 게이트의 고정값은 PostgreSQL·OpenAPI·테스트 검증 결과에서 가져왔습니다."
    )
    ws["A18"].font = Font(name="Arial", size=9, italic=True, color=COLORS["muted"])
    ws["A18"].fill = PatternFill("solid", fgColor=COLORS["canvas"])
    ws["A18"].alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[18].height = 34
    ws.freeze_panes = "A3"
    configure_print_preview(ws, 10, 18)
    return ws


def add_validation(wb: Workbook, payload: dict[str, Any]) -> Any:
    validation_rows = [
        (
            "물리 테이블 수",
            payload["summary"]["table_count"],
            f"=COUNTA('Tables'!C5:C{len(payload['tables']) + 4})",
        ),
        (
            "논리 테이블 수",
            payload["summary"]["logical_table_count"],
            f"=COUNTIF('Tables'!J5:J{len(payload['tables']) + 4},\"N\")",
        ),
        (
            "파티션 수",
            payload["summary"]["partition_count"],
            f"=COUNTIF('Tables'!J5:J{len(payload['tables']) + 4},\"Y\")",
        ),
        (
            "컬럼 수",
            payload["summary"]["column_count"],
            f"=COUNTA('Columns'!E5:E{len(payload['columns']) + 4})",
        ),
        (
            "FK 관계 수",
            payload["summary"]["relationship_count"],
            f"=COUNTA('Relationships'!A5:A{len(payload['relationships']) + 4})",
        ),
        (
            "OpenAPI 작업 수",
            payload["summary"]["api_operation_count"],
            f"=COUNTA('API Operations'!A5:A{len(payload['api_operations']) + 4})",
        ),
        (
            "매핑 완료 작업 수",
            payload["summary"]["mapped_operation_count"],
            (
                f"=COUNTIF('API Operations'!K5:K{len(payload['api_operations']) + 4},"
                '"PASS")'
            ),
        ),
    ]
    ws = add_data_sheet(
        wb,
        name="Validation",
        title="산출물 교차 검증",
        subtitle="Expected와 상세 시트에서 다시 계산한 Actual이 일치해야 합니다.",
        headers=["Metric", "Expected", "Actual", "Result"],
        rows=[
            [metric, expected, formula, f'=IF(B{index}=C{index},"PASS","FAIL")']
            for index, (metric, expected, formula) in enumerate(
                validation_rows, start=5
            )
        ],
        widths=[32, 18, 18, 16],
        table_name="ModelValidation",
    )
    for row in range(5, 5 + len(validation_rows)):
        ws.cell(row=row, column=2).number_format = "#,##0"
        ws.cell(row=row, column=3).number_format = "#,##0"
        ws.cell(row=row, column=2).comment = Comment(SOURCE_COMMENT, "OpenAI Codex")
    ws.conditional_formatting.add(
        f"D5:D{4 + len(validation_rows)}",
        FormulaRule(
            formula=['D5="PASS"'],
            fill=PatternFill("solid", fgColor=COLORS["green_light"]),
            font=Font(name="Arial", bold=True, color=COLORS["green"]),
        ),
    )
    ws.conditional_formatting.add(
        f"D5:D{4 + len(validation_rows)}",
        FormulaRule(
            formula=['D5="FAIL"'],
            fill=PatternFill("solid", fgColor=COLORS["red_light"]),
            font=Font(name="Arial", bold=True, color=COLORS["red"]),
        ),
    )
    return ws


def build_workbook(payload: dict[str, Any]) -> Workbook:
    wb = Workbook()
    wb.creator = "OpenAI Codex"
    wb.title = "OMF-MES Logical Table Specification v4"
    wb.subject = "Logical model, PostgreSQL catalog, and OpenAPI-to-table traceability"
    wb.description = (
        "Generated from docs/data-model/workbook-data.json and validated against "
        "the OMF-MES PostgreSQL catalog and OpenAPI contracts."
    )
    wb.keywords = "OMF-MES, data model, PostgreSQL, OpenAPI, traceability"
    wb.calculation.fullCalcOnLoad = True
    wb.calculation.forceFullCalc = True
    wb.calculation.calcMode = "auto"

    add_summary(wb, payload)

    tables = add_data_sheet(
        wb,
        name="Tables",
        title="전체 테이블 명세",
        subtitle="논리명·생명주기·목적·키 구조를 한 행 단위로 조회합니다.",
        headers=[
            "Schema",
            "Table",
            "Qualified Name",
            "Logical Name",
            "Lifecycle",
            "Purpose",
            "Columns",
            "Primary Key",
            "FK Count",
            "Partition",
        ],
        rows=[
            [
                row["schema"],
                row["table"],
                row["qualified_name"],
                row["logical_name"],
                row["lifecycle"],
                row["purpose"],
                row["column_count"],
                row["primary_key"],
                row["foreign_key_count"],
                yn(row["is_partition"]),
            ]
            for row in payload["tables"]
        ],
        widths=[14, 30, 42, 25, 15, 65, 12, 30, 12, 12],
        table_name="ModelTables",
        wrap_columns={6},
    )
    tables.conditional_formatting.add(
        f"J5:J{len(payload['tables']) + 4}",
        CellIsRule(
            operator="equal",
            formula=['"Y"'],
            fill=PatternFill("solid", fgColor=COLORS["orange_light"]),
            font=Font(name="Arial", color=COLORS["orange"]),
        ),
    )

    add_data_sheet(
        wb,
        name="Columns",
        title="전체 컬럼 명세",
        subtitle="필수 여부는 PostgreSQL NOT NULL 기준이며 API 요청 required와 구분됩니다.",
        headers=[
            "Qualified Table",
            "Schema",
            "Table",
            "Ordinal",
            "Column",
            "Data Type",
            "Required",
            "Key / Reference",
            "Default",
        ],
        rows=[
            [
                row["qualified_table"],
                row["schema"],
                row["table"],
                row["ordinal"],
                row["column"],
                row["data_type"],
                yn(row["required"]),
                row["key_reference"],
                row["default"],
            ]
            for row in payload["columns"]
        ],
        widths=[42, 14, 30, 10, 30, 28, 12, 44, 52],
        table_name="ModelColumns",
        wrap_columns={8, 9},
    )

    add_data_sheet(
        wb,
        name="Relationships",
        title="전체 테이블 관계",
        subtitle="PostgreSQL 카탈로그에서 추출한 모든 외래키 관계입니다.",
        headers=[
            "FK Name",
            "Source Table",
            "Source Columns",
            "Target Table",
            "Target Columns",
            "On Delete",
        ],
        rows=[
            [
                row["name"],
                row["source_table"],
                row["source_columns"],
                row["target_table"],
                row["target_columns"],
                row["on_delete"],
            ]
            for row in payload["relationships"]
        ],
        widths=[45, 42, 34, 42, 34, 14],
        table_name="ModelRelationships",
    )

    api_operations = add_data_sheet(
        wb,
        name="API Operations",
        title="OpenAPI 작업 목록",
        subtitle=(
            f"7개 계약 파일의 {payload['summary']['api_operation_count']}개 "
            "path operation과 매핑 상태입니다."
        ),
        headers=[
            "Operation",
            "Domain",
            "Method",
            "Path",
            "Summary",
            "Tags",
            "Deprecated",
            "Idempotency-Key",
            "If-Match",
            "Related Tables",
            "Status",
        ],
        rows=[
            [
                row["id"],
                row["domain"],
                row["method"],
                row["path"],
                row["summary"],
                row["tags"],
                yn(row["deprecated"]),
                yn(row["idempotency_key"]),
                yn(row["if_match"]),
                row["relation_count"],
                row["mapping_status"],
            ]
            for row in payload["api_operations"]
        ],
        widths=[55, 32, 12, 55, 48, 20, 12, 18, 14, 16, 12],
        table_name="ApiOperations",
        wrap_columns={4, 5},
    )
    for row in range(5, len(payload["api_operations"]) + 5):
        method = api_operations.cell(row=row, column=3)
        palette = {
            "GET": (COLORS["green_light"], COLORS["green"]),
            "POST": ("E3EEFF", COLORS["blue"]),
            "PUT": (COLORS["orange_light"], COLORS["orange"]),
            "PATCH": (COLORS["purple_light"], COLORS["purple"]),
            "DELETE": (COLORS["red_light"], COLORS["red"]),
        }.get(str(method.value), (COLORS["canvas"], COLORS["ink"]))
        method.fill = PatternFill("solid", fgColor=palette[0])
        method.font = Font(name="Arial", size=9, bold=True, color=palette[1])
        status = api_operations.cell(row=row, column=11)
        status_palette = {
            "PASS": (COLORS["green_light"], COLORS["green"]),
            "PARTIAL": (COLORS["orange_light"], COLORS["orange"]),
            "FAIL": (COLORS["red_light"], COLORS["red"]),
        }.get(str(status.value), (COLORS["canvas"], COLORS["ink"]))
        status.fill = PatternFill("solid", fgColor=status_palette[0])
        status.font = Font(name="Arial", size=9, bold=True, color=status_palette[1])

    api_mapping = add_data_sheet(
        wb,
        name="API Mapping",
        title="API ↔ 테이블 매핑",
        subtitle="API 처리에 참여하는 테이블의 역할·접근 유형·근거를 한 행씩 표시합니다.",
        headers=[
            "Domain",
            "Method",
            "Path",
            "Summary",
            "Table",
            "Role",
            "Access",
            "Basis",
            "Idempotency-Key",
            "If-Match",
        ],
        rows=[
            [
                row["domain"],
                row["method"],
                row["path"],
                row["summary"],
                row["table"],
                row["role"],
                row["access"],
                row["basis"],
                yn(row["idempotency_key"]),
                yn(row["if_match"]),
            ]
            for row in payload["api_mapping"]
        ],
        widths=[30, 12, 55, 48, 42, 18, 15, 22, 18, 14],
        table_name="ApiTableMapping",
        wrap_columns={3, 4},
    )
    access_palette = {
        "READ": (COLORS["green_light"], COLORS["green"]),
        "WRITE": (COLORS["orange_light"], COLORS["orange"]),
        "READ_WRITE": (COLORS["purple_light"], COLORS["purple"]),
    }
    for row in range(5, len(payload["api_mapping"]) + 5):
        access = api_mapping.cell(row=row, column=7)
        fill, font = access_palette.get(
            str(access.value), (COLORS["canvas"], COLORS["ink"])
        )
        access.fill = PatternFill("solid", fgColor=fill)
        access.font = Font(name="Arial", size=9, bold=True, color=font)

    gaps = add_data_sheet(
        wb,
        name="Contract Gaps",
        title="계약 차이 해소표",
        subtitle="최신 Wiki·OpenAPI와 기존 v3 물리 모델의 구조 차이 및 v4 반영 결과입니다.",
        headers=["No.", "Confirmed Gap", "v4 Resolution", "Status"],
        rows=[
            [row["no"], row["gap"], row["resolution"], row["status"]]
            for row in payload["gaps"]
        ],
        widths=[8, 44, 65, 18],
        table_name="ContractGaps",
        wrap_columns={2, 3},
    )
    for row in range(5, len(payload["gaps"]) + 5):
        status = gaps.cell(row=row, column=4)
        status.fill = PatternFill("solid", fgColor=COLORS["green_light"])
        status.font = Font(name="Arial", size=9, bold=True, color=COLORS["green"])

    add_validation(wb, payload)
    return wb


def main() -> None:
    args = parse_args()
    payload = json.loads(args.payload.read_text(encoding="utf-8"))
    workbook = build_workbook(payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(args.output)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "sheets": workbook.sheetnames,
                "tables": len(payload["tables"]),
                "columns": len(payload["columns"]),
                "relationships": len(payload["relationships"]),
                "api_operations": len(payload["api_operations"]),
                "api_mapping_rows": len(payload["api_mapping"]),
                "contract_gaps": len(payload["gaps"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
