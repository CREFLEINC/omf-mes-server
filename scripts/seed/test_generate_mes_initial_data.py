"""Tests for the static MES initial-data SQL generator."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch

from generate_mes_initial_data import TableSpec, generate


class GenerateMesInitialDataTest(TestCase):
    """Exercise deterministic COPY rendering and source validation."""

    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.source = self.root / "source.sqlite3"
        self.template = self.root / "template.sql"

        connection = sqlite3.connect(self.source)
        try:
            connection.execute(
                "CREATE TABLE source_item "
                "(code TEXT, name TEXT, is_canceled INTEGER NOT NULL)"
            )
            connection.executemany(
                "INSERT INTO source_item VALUES (?, ?, ?)",
                (("A", "line one\nline two", 0), ("B", 'quoted "name"', 0)),
            )
            connection.commit()
        finally:
            connection.close()

        self.template.write_text(
            "BEGIN;\n-- __COPY_ERP_ITEM__\nCOMMIT;\n", encoding="utf-8"
        )

    def test_generate_preserves_multiline_and_quoted_csv_values(self) -> None:
        """COPY CSV must preserve source text without requiring external files."""
        table = TableSpec("source_item", "erp_item", 2, "code")
        with patch("generate_mes_initial_data.TABLES", (table,)):
            result = generate(self.source, self.template)

        self.assertIn("COPY erp_seed.erp_item", result)
        self.assertIn('A,"line one\nline two",0', result)
        self.assertIn('B,"quoted ""name""",0', result)
        self.assertNotIn("__COPY_", result)

    def test_generate_rejects_an_unexpected_snapshot_count(self) -> None:
        """A changed ERP snapshot must be reviewed before publishing new SQL."""
        table = TableSpec("source_item", "erp_item", 3, "code")
        with patch("generate_mes_initial_data.TABLES", (table,)):
            with self.assertRaisesRegex(ValueError, "expected 3 active rows"):
                generate(self.source, self.template)


if __name__ == "__main__":
    main()
