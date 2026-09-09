import { Workbook } from "exceljs";

import { ERROR_CODE, ErrorItem } from "../../common/errors";
import type { SparePartCreate } from "./spare-part.service";

/** 현행 대장의 열이 확정되기 전까지 계약에서 확실한 세 칸만 이름으로 찾는다. 통보 271. */
const HEADERS: Record<string, readonly string[]> = {
  plantCode: ["공장코드", "공장", "plantcode"],
  sparePartCode: ["예비품코드", "부품코드", "코드", "sparepartcode"],
  sparePartName: ["예비품명", "부품명", "명칭", "이름", "sparepartname"],
};

export interface SparePartImportRow {
  /** 머리글을 제외한 자료 행의 순번(0부터). */
  index: number;
  plantCode: string | null;
  values: Omit<SparePartCreate, "plantId">;
}

export interface SparePartImportParse {
  rows: SparePartImportRow[];
  error?: ErrorItem;
}

export function resolveSparePartImportPlant(
  row: SparePartImportRow,
  plants: readonly { plant_id: bigint; plant_code: string }[],
): number | null {
  if (row.plantCode === null) {
    return plants.length === 1 ? Number(plants[0].plant_id) : null;
  }
  const found = plants.find((plant) => plant.plant_code === row.plantCode);
  return found === undefined ? null : Number(found.plant_id);
}

export async function parseSparePartWorkbook(
  buffer: Buffer,
): Promise<SparePartImportParse> {
  const sheet = await firstSheet(buffer);
  if (sheet === null)
    return { rows: [], error: unreadable("엑셀 파일을 열 수 없습니다.") };

  const header = sheet.rows[0] ?? [];
  const column = mapColumns(header);
  if (
    column.sparePartCode === undefined ||
    column.sparePartName === undefined
  ) {
    return {
      rows: [],
      error: unreadable("머리글에서 예비품 코드·명칭 열을 찾지 못했습니다."),
    };
  }

  const rows = sheet.rows.slice(1).map((cells, index) => {
    const plantCode = text(cells[column.plantCode ?? -1]);
    const sparePartCode = text(cells[column.sparePartCode as number]);
    const sparePartName = text(cells[column.sparePartName as number]);
    return {
      index,
      plantCode,
      values: {
        sparePartCode: sparePartCode ?? "",
        sparePartName: sparePartName ?? "",
      },
    };
  });

  // 공장만 적힌 행도 자료 행이다 — 코드·명칭 REQUIRED 실패로 돌려줘야 한다.
  return {
    rows: rows.filter(
      (row) =>
        row.plantCode !== null ||
        row.values.sparePartCode !== "" ||
        row.values.sparePartName !== "",
    ),
  };
}

async function firstSheet(
  buffer: Buffer,
): Promise<{ rows: unknown[][] } | null> {
  try {
    const workbook = new Workbook();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) return null;
    const rows: unknown[][] = [];
    sheet.eachRow((row) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        cells[columnNumber - 1] = cell.value;
      });
      rows.push(cells);
    });
    return { rows };
  } catch {
    return null;
  }
}

function mapColumns(
  header: readonly unknown[],
): Record<string, number | undefined> {
  const found: Record<string, number | undefined> = {};
  header.forEach((cell, position) => {
    const label = (text(cell) ?? "").replace(/[\s()_-]/g, "").toLowerCase();
    if (label === "") return;
    for (const [field, aliases] of Object.entries(HEADERS)) {
      if (found[field] === undefined && aliases.includes(label))
        found[field] = position;
    }
  });
  return found;
}

function text(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "object" && "result" in cell) {
    return text((cell as { result: unknown }).result);
  }
  if (typeof cell === "object" && "text" in cell) {
    return text((cell as { text: unknown }).text);
  }
  const value = String(cell).trim();
  return value === "" ? null : value;
}

function unreadable(message: string): ErrorItem {
  return { scope: "screen", code: ERROR_CODE.INVALID, message };
}
