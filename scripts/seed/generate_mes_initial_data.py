#!/usr/bin/env python3
"""Generate a self-contained PostgreSQL seed file from the ERP gateway SQLite DB."""

from __future__ import annotations

import argparse
import csv
import io
import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TableSpec:
    source_name: str
    staging_name: str
    expected_rows: int
    order_by: str


TABLES = (
    TableSpec("mes_common_code", "erp_code", 244, "type_code, code, plant_cd"),
    TableSpec("mes_employee", "erp_employee", 786, "emp_code"),
    TableSpec("mes_item", "erp_item", 9_813, "plant_cd, item_cd"),
    TableSpec("mes_biz_partner", "erp_partner", 931, "bp_cd"),
    TableSpec(
        "mes_bom",
        "erp_bom",
        22_793,
        "plant_cd, prnt_item_cd, child_item_seq, child_item_cd",
    ),
)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Generate the static MES initial-data SQL file."
    )
    parser.add_argument("source", type=Path, help="gateway.sqlite3 path")
    parser.add_argument("output", type=Path, help="output .sql path")
    parser.add_argument(
        "--template",
        type=Path,
        default=Path(__file__).with_name("mes-initial-data-template.sql"),
        help="SQL template path",
    )
    return parser.parse_args()


def table_columns(connection: sqlite3.Connection, table_name: str) -> list[str]:
    """Return source columns in their physical order."""
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    if not rows:
        raise ValueError(f"source table not found: {table_name}")
    return [str(row[1]) for row in rows]


def active_rows(
    connection: sqlite3.Connection, table: TableSpec, columns: list[str]
) -> list[sqlite3.Row]:
    """Load active source rows in deterministic order and verify the snapshot count."""
    selected_columns = ", ".join(f'"{column}"' for column in columns)
    query = (
        f"SELECT {selected_columns} FROM {table.source_name} "
        f"WHERE is_canceled = 0 ORDER BY {table.order_by}"
    )
    rows = connection.execute(query).fetchall()
    if len(rows) != table.expected_rows:
        raise ValueError(
            f"{table.source_name}: expected {table.expected_rows:,} active rows, "
            f"found {len(rows):,}"
        )
    return rows


def copy_block(table: TableSpec, columns: list[str], rows: list[sqlite3.Row]) -> str:
    """Render one psql COPY FROM STDIN block as RFC-compatible CSV."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(rows)
    column_list = ", ".join(columns)
    return (
        f"COPY erp_seed.{table.staging_name} ({column_list}) FROM STDIN "
        "WITH (FORMAT csv, HEADER true);\n"
        f"{buffer.getvalue()}"
        "\\.\n"
    )


def generate(source: Path, template_path: Path) -> str:
    """Generate SQL after validating source integrity and all template markers."""
    source_uri = f"file:{source.resolve()}?mode=ro&immutable=1"
    connection = sqlite3.connect(source_uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"SQLite integrity check failed: {integrity}")

        rendered = template_path.read_text(encoding="utf-8")
        for table in TABLES:
            columns = table_columns(connection, table.source_name)
            rows = active_rows(connection, table, columns)
            marker = f"-- __COPY_{table.staging_name.upper()}__"
            if rendered.count(marker) != 1:
                raise ValueError(f"template marker must appear exactly once: {marker}")
            rendered = rendered.replace(marker, copy_block(table, columns, rows))
    finally:
        connection.close()

    if "-- __COPY_" in rendered:
        raise ValueError("unresolved COPY marker remains in template")
    return rendered


def main() -> None:
    """Generate the SQL artifact."""
    args = parse_args()
    generated_sql = generate(args.source, args.template)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generated_sql, encoding="utf-8")
    print(f"generated {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
